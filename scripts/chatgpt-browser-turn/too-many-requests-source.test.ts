import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeShape,
  captureTooManyRequestsSource,
  parseJsonRejectingDuplicateKeys,
  parseSourceCommentBody,
  shapeSha256,
  verifyLiveSource,
  writeCapturedSource,
  type TooManyRequestsDialogShapeV2,
} from './too-many-requests-source.ts';

const marker = '<!-- issue-1168-too-many-requests-production-shape:v2 -->';

function fixtureShape(): TooManyRequestsDialogShapeV2 {
  return canonicalizeShape({
    schema: 'too-many-requests-dialog-shape/v2',
    dialog: {
      page_dialog_ordinal: 0,
      tag_name: 'div',
      role_attribute_class: 'dialog',
      aria_modal_attribute_class: 'true',
      aria_owns_attribute_class: 'absent',
    },
    heading: {
      child_index_path: [0],
      tag_name: 'h2',
      role_attribute_class: 'heading',
    },
    acknowledgement: {
      child_index_path: [1],
      tag_name: 'button',
      role_attribute_class: 'button',
    },
  });
}

function sourceObject(shape = fixtureShape()) {
  return {
    schema: 'issue-1168-too-many-requests-production-shape/v2',
    issue: 1168,
    observation_kind: 'natural',
    observed_at: '2026-08-03T00:00:00.000Z',
    source_local_occurrence: 'capture:abc123',
    operator_attestation: 'scrubbed-no-private-data',
    shape_sha256: shapeSha256(shape),
    shape,
  } as const;
}

function bodyFor(source = sourceObject()): string {
  return `${marker}\n${JSON.stringify(source)}`;
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeEvidence(body = bodyFor()) {
  const root = mkdtempSync(join(tmpdir(), 'issue-1168-source-'));
  const fixture = join(root, 'fixture.json');
  const binding = join(root, 'binding.json');
  const shape = sourceObject().shape;
  writeFileSync(fixture, JSON.stringify(shape));
  const commentId = 5161000000;
  const updatedAt = '2026-08-03T00:00:00Z';
  const commentUrl = `https://github.com/chetwerikoff/orchestrator-pack/issues/1168#issuecomment-${commentId}`;
  writeFileSync(binding, JSON.stringify({
    schema: 'issue-1168-source-binding/v1',
    comment_id: commentId,
    comment_url: commentUrl,
    updated_at: updatedAt,
    body_sha256: sha(body),
    shape_sha256: sourceObject().shape_sha256,
  }));
  return { binding, fixture, commentId, commentUrl, updatedAt, body };
}

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly tagName: string;
  readonly role: string;
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly visible: boolean;
  readonly enabled: boolean;

  constructor(
    tagName: string,
    role: string,
    name: string,
    attrs: Record<string, string> = {},
    visible = true,
    enabled = true,
  ) {
    this.tagName = tagName;
    this.role = role;
    this.name = name;
    this.attrs = attrs;
    this.visible = visible;
    this.enabled = enabled;
  }

  append(child: FakeElement): this {
    child.parentElement = this;
    this.children.push(child);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

class FakeLocator {
  readonly elements: FakeElement[];

  constructor(elements: FakeElement[]) {
    this.elements = elements;
  }

  async count(): Promise<number> { return this.elements.length; }
  nth(index: number): FakeLocator { return new FakeLocator(this.elements[index] ? [this.elements[index]!] : []); }
  async isVisible(): Promise<boolean> { return this.elements[0]?.visible ?? false; }
  async isEnabled(): Promise<boolean> { return this.elements[0]?.enabled ?? false; }
  async getAttribute(name: string): Promise<string | null> { return this.elements[0]?.getAttribute(name) ?? null; }
  getByRole(role: string, options: { name: string; exact: boolean }): FakeLocator {
    const root = this.elements[0];
    if (!root || !options.exact) return new FakeLocator([]);
    return new FakeLocator(descendants(root).filter((item) => item.role === role && item.name === options.name));
  }
  async evaluate<T, A>(callback: (element: FakeElement, arg: A) => T, arg?: A): Promise<T> {
    const element = this.elements[0];
    if (!element) throw new Error('missing_element');
    return callback(element, arg as A);
  }
  async elementHandle(): Promise<FakeElement | null> { return this.elements[0] ?? null; }
}

function exactPage(options: { duplicateDialog?: boolean; disabledButton?: boolean } = {}) {
  const heading = new FakeElement('H2', 'heading', 'Too many requests');
  const button = new FakeElement('BUTTON', 'button', 'Got it', {}, true, !options.disabledButton);
  const dialog = new FakeElement('DIV', 'dialog', '', { role: 'dialog', 'aria-modal': 'true' })
    .append(heading)
    .append(button);
  const dialogs = options.duplicateDialog
    ? [dialog, new FakeElement('DIV', 'dialog', '', { role: 'dialog', 'aria-modal': 'true' })]
    : [dialog];
  return {
    locator(selector: string) {
      expect(selector).toBe('[role="dialog"][aria-modal="true"]');
      return new FakeLocator(dialogs);
    },
  };
}

describe('too-many-requests production source', () => {
  it('rejects duplicate JSON keys before materialization', () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"a":1,"a":2}')).toThrow('json_duplicate_key');
    expect(parseJsonRejectingDuplicateKeys('{"a":{"x":1},"b":{"x":2}}')).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });

  it('accepts only the exact compact two-line source body', () => {
    expect(parseSourceCommentBody(bodyFor())).toEqual(sourceObject());
    expect(() => parseSourceCommentBody(`${bodyFor()}\n`)).toThrow('body_grammar_invalid');
    expect(() => parseSourceCommentBody(bodyFor().replace('"issue":1168', '"issue":1168,"issue":1168')))
      .toThrow('body_grammar_invalid');
    expect(() => parseSourceCommentBody(bodyFor().replace('2026-08-03T00:00:00.000Z', '2026-02-30T00:00:00.000Z')))
      .toThrow('source_schema_invalid');
  });

  it('verifies the immutable live comment and exact fixture bytes', () => {
    const evidence = writeEvidence();
    const result = verifyLiveSource({
      bindingPath: evidence.binding,
      fixturePath: evidence.fixture,
      selector: 'too-many-requests-source-verifier',
    }, {
      transport: {
        runGh: (argv) => {
          expect(argv).toEqual(['gh', 'api', `repos/chetwerikoff/orchestrator-pack/issues/comments/${evidence.commentId}`]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: evidence.commentId,
              html_url: evidence.commentUrl,
              updated_at: evidence.updatedAt,
              body: evidence.body,
            }),
            stderr: '',
          };
        },
      },
    });
    expect(result).toEqual({
      schema: 'issue-1168-source-verification/v1',
      status: 'verified',
      selector: 'too-many-requests-source-verifier',
      comment_id: evidence.commentId,
      comment_url: evidence.commentUrl,
      updated_at: evidence.updatedAt,
      body_sha256: sha(evidence.body),
      shape_sha256: sourceObject().shape_sha256,
      fixture_sha256: sourceObject().shape_sha256,
    });
  });

  it('keeps body, shape, and fixture failures distinct', () => {
    const evidence = writeEvidence();
    const comment = (body: string) => ({
      runGh: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          id: evidence.commentId,
          html_url: evidence.commentUrl,
          updated_at: evidence.updatedAt,
          body,
        }),
        stderr: '',
      }),
    });
    expect(verifyLiveSource({
      bindingPath: evidence.binding,
      fixturePath: evidence.fixture,
      selector: 'too-many-requests-live-source-receipt',
    }, { transport: comment(`${evidence.body} `) })).toMatchObject({ status: 'rejected', reason: 'body_digest_mismatch' });

    writeFileSync(evidence.fixture, `${readFileSync(evidence.fixture, 'utf8')}\n`);
    expect(verifyLiveSource({
      bindingPath: evidence.binding,
      fixturePath: evidence.fixture,
      selector: 'too-many-requests-source-verifier',
    }, { transport: comment(evidence.body) })).toMatchObject({ status: 'rejected', reason: 'fixture_mismatch' });
  });

  it('captures only the minimized public surface and writes no trailing newline', async () => {
    const source = await captureTooManyRequestsSource(exactPage(), {
      observedAt: '2026-08-03T00:00:00.000Z',
      sourceLocalOccurrence: 'capture:test',
    });
    expect(source.shape).toEqual(fixtureShape());
    const root = mkdtempSync(join(tmpdir(), 'issue-1168-capture-'));
    const output = join(root, 'source.json');
    writeCapturedSource(output, source);
    const bytes = readFileSync(output, 'utf8');
    expect(bytes).toBe(JSON.stringify(source));
    expect(bytes.endsWith('\n')).toBe(false);
  });

  it('fails closed for ambiguous dialogs and disabled acknowledgement', async () => {
    await expect(captureTooManyRequestsSource(exactPage({ duplicateDialog: true }))).rejects.toThrow('capture_ambiguous_visible_match');
    await expect(captureTooManyRequestsSource(exactPage({ disabledButton: true }))).rejects.toThrow('capture_acknowledgement_disabled');
  });
});
