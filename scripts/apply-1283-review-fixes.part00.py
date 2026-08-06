from pathlib import Path
import re, json


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one literal match, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, repl: str, flags: int = 0) -> None:
    p = Path(path)
    text = p.read_text()
    new, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, got {count}: {pattern[:100]!r}")
    p.write_text(new)

state = 'scripts/chatgpt-browser-turn/state-light-turn.ts'
replace_once(state, "  SEND_BUTTON_SELECTOR,\n  STOP_BUTTON_SELECTOR,\n  stripUiCollapseAffixes,", "  SEND_BUTTON_SELECTOR,\n  stripUiCollapseAffixes,")
replace_once(state, "} from './state-light-turn-recovery.ts';\n\nconst DEFAULT_TIMEOUT_MS", "} from './state-light-turn-recovery.ts';\nimport {\n  buildBrowserTurnCancellationReceipt,\n  isSupportedChatGptConversationUrl,\n  readRecoveryAuthoritativeUserMessages,\n  stopOwnedGeneration,\n  type StopOwnedGenerationOutcome,\n} from './state-light-cancellation.ts';\n\nexport { stopOwnedGeneration };\nexport type { StopOwnedGenerationOutcome };\n\nconst DEFAULT_TIMEOUT_MS")
replace_once(state, "  readonly cleanupAction?: PageCleanupAction;\n  readonly ownedConversationUrl?: string;", "  readonly cleanupAction?: PageCleanupAction;\n  /** Exact invocation-created page authorized for one Stop attempt. */\n  readonly stopAuthorityPage?: any;\n  readonly ownedConversationUrl?: string;")
replace_once(state, "const cleanupAuthorityUnprovenPages = new WeakSet<object>();", "const cleanupAuthorityUnprovenPages = new WeakSet<object>();\nconst stopAuthorityPages = new WeakSet<object>();")
regex_once(
    state,
    r"export type StopOwnedGenerationOutcome =\n(?:.|\n)*?\n}\n\nexport function decidePageCleanupAction",
    "export function decidePageCleanupAction",
)
replace_once(state, "  let ownershipForfeited = false;", "  let ownershipForfeited = false;\n  let cancellationReceiptEmitted = false;")
replace_once(state, "    const marker = generateOwnedPromptMarker();\n    const markedPayload = wrapOwnedPromptPayload(marker, snapshot.text);", "    const marker = generateOwnedPromptMarker();\n    const markedPayload = wrapOwnedPromptPayload(marker, snapshot.text);\n\n    const emitCancellationReceipt = (conversationUrl: string): void => {\n      if (cancellationReceiptEmitted || sendCount !== 1) return;\n      const receipt = buildBrowserTurnCancellationReceipt({\n        invocationId,\n        profileKey,\n        conversationUrl,\n        marker,\n        sendCount,\n      });\n      if (!receipt) return;\n      emit(receipt);\n      cancellationReceiptEmitted = true;\n    };")
replace_once(state, "      sendCount += 1;\n      afterSend = true;\n      return null;", "      sendCount += 1;\n      afterSend = true;\n      if (page && typeof page === 'object') stopAuthorityPages.add(page);\n      if (!config.newChat && config.chatUrl) {\n        emitCancellationReceipt(normalizeConversationUrl(config.chatUrl));\n      }\n      return null;")
replace_once(state, "          if (claim === 'claimed' || claim === 'owned') {\n            claimed = true;\n            ownedConversationUrl = conversationUrl;\n            break;\n          }", "          if (claim === 'claimed' || claim === 'owned') {\n            claimed = true;\n            ownedConversationUrl = conversationUrl;\n            emitCancellationReceipt(conversationUrl);\n            break;\n          }")
replace_once(state, "      cleanupAuthorityPage: page,\n      ...(targetChatUrl ?? ownedConversationUrl", "      cleanupAuthorityPage: page,\n      stopAuthorityPage: page,\n      ...(targetChatUrl ?? ownedConversationUrl")
replace_once(state, "      return {\n        browser: failure.browser,\n        cleanupAction: 'preserve',", "      return {\n        browser: failure.browser,\n        ...(failure.stopAuthorityPage ? {\n          page: failure.stopAuthorityPage,\n          stopAuthorityPage: failure.stopAuthorityPage,\n        } : {}),\n        cleanupAction: 'preserve',")
old_enum = """          enumeratePages: async (activeBrowser) => {
            const contexts = (activeBrowser as any).contexts();
            if (!Array.isArray(contexts)) throw new Error('recovery_context_enumeration_failed');
            const pages: unknown[] = [];
            for (const context of contexts) {
              const currentPages = context.pages();
              if (!Array.isArray(currentPages)) throw new Error('recovery_page_enumeration_failed');
              pages.push(...currentPages);
            }
            return pages;
          },
          pageUrl: (candidate) => String((candidate as any).url()),
          normalizeConversationUrl,
          isSupportedConversationUrl: (value) => value.includes('/c/'),
          readAuthoritativeMessages: async (candidate) => {
            const observed = await readPageObservation(candidate, undefined, undefined, true);
            return {
              messages: observed.messages,
              incomplete: observed.transcriptIncomplete,
            };
          },
"""
new_enum = """          enumeratePages: async (activeBrowser) => {
            const contexts = (activeBrowser as any).contexts();
            if (!Array.isArray(contexts) || contexts.length !== 1) {
              throw new Error('recovery_context_count_unproven');
            }
            const pages = contexts[0].pages();
            if (!Array.isArray(pages)) throw new Error('recovery_page_enumeration_failed');
            const targetUrl = recoveryState.immutableConversationUrl;
            if (!targetUrl) return pages;
            return pages.filter((candidate: any) => {
              try {
                return normalizeConversationUrl(String(candidate.url())) === targetUrl;
              } catch {
                return false;
              }
            });
          },
          pageUrl: (candidate) => String((candidate as any).url()),
          normalizeConversationUrl,
          isSupportedConversationUrl: isSupportedChatGptConversationUrl,
          readAuthoritativeMessages: readRecoveryAuthoritativeUserMessages,
"""
replace_once(state, old_enum, new_enum)
old_recovered = """      browser = recovered.browser;
      if (recovered.kind === 'failure') return recoveryFailureOutcome(recovered);

      page = recovered.page;
      if (!recovered.cleanupOwned && page && typeof page === 'object') {
        cleanupAuthorityUnprovenPages.add(page);
      }
      recoveryState.immutableConversationUrl = recovered.conversationUrl;
      if (config.newChat && !ownedConversationUrl) {
        ownedConversationUrl = recovered.conversationUrl;
      }
      if (config.directPublication) installDirectPublicationObserver(page, directObservation);
      baselineCount = 0;
      return null;
"""
new_recovered = """      browser = recovered.browser;
      if (recovered.kind === 'failure') return recoveryFailureOutcome(recovered);

      if (config.newChat && !ownedConversationUrl) {
        let claim: ReturnType<typeof tryClaimStateLightFreshConversation>;
        try {
          claim = tryClaimStateLightFreshConversation(
            profileKey,
            recovered.conversationUrl,
            invocationId,
            config.timeoutMs,
          );
        } catch {
          claim = 'contended';
        }
        if (claim === 'contended') {
          ownershipForfeited = true;
          incident(
            'ownership_fence_lost',
            'state_light_recovered_conversation_claim_contended',
            'retain_owned_page_no_resend',
          );
          return {
            page: recovered.page,
            browser,
            ownershipForfeited: true,
            cleanupAction: 'preserve',
            result: compactResult(
              'driver_error',
              'invocation',
              'state_light_recovered_conversation_claim_contended',
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              navigation,
              incidents,
              { conversation_id: recovered.conversationUrl },
              journalWriteFailed,
            ),
          };
        }
        ownedConversationUrl = recovered.conversationUrl;
        emitCancellationReceipt(recovered.conversationUrl);
      }

      page = recovered.page;
      if (!recovered.cleanupOwned && page && typeof page === 'object') {
        cleanupAuthorityUnprovenPages.add(page);
      }
      if (recovered.stopAuthorityPage === page && page && typeof page === 'object') {
        stopAuthorityPages.add(page);
      }
      recoveryState.immutableConversationUrl = recovered.conversationUrl;
      if (config.directPublication) installDirectPublicationObserver(page, directObservation);
      baselineCount = 0;
      return null;
"""
replace_once(state, old_recovered, new_recovered)
replace_once(state, "      const durableConversationUrl = targetChatUrl\n        ?? ownedConversationUrl\n        ?? pageConversationUrl(page);", "      const durableConversationUrl = targetChatUrl\n        ?? ownedConversationUrl\n        ?? pageConversationUrl(page);\n      if (\n        durableConversationUrl\n        && markerCardinality.matchingUserCarrierCount === 1\n        && markerCardinality.exactMarkerTokenCount === 1\n      ) {\n        emitCancellationReceipt(durableConversationUrl);\n      }")
