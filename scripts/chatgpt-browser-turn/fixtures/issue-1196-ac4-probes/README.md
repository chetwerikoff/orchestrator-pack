# Issue 1196 AC4/AC5 production-probe evidence

The five authorized production attempts below all used a fresh chat and a fresh
invocation. The original terminal transcripts remain in the session terminal
records named in this table; the terminal-result lines and capture bytes are
preserved here verbatim.

| target | probe | invocation | terminal transcript | capture |
| --- | --- | --- | --- | --- |
| #1244 | success | `550e8400-e29b-41d4-a716-446655440101` | `terminals/681289.txt` | `1244-success.capture.json` |
| #1244 | definitive-no-commit | `550e8400-e29b-41d4-a716-446655440102` | `terminals/681290.txt` | `1244-no-commit.capture.json` |
| #1252 | success | `550e8400-e29b-41d4-a716-446655440201` | `terminals/681291.txt` | `1252-success.capture.json` |
| #1252 | definitive-no-commit | `550e8400-e29b-41d4-a716-446655440202` | `terminals/681292.txt` | `1252-no-commit.capture.json` |
| #1252 | success-final | `550e8400-e29b-41d4-a716-446655440203` | `terminals/681293.txt` | `1252-success-final.capture.json` |

Exact terminal-result lines:

```text
{"schema":"turn-result/v1","state":"ok","scope":"none","cause":"capability_probe_captured","invocation_id":"550e8400-e29b-41d4-a716-446655440101","configured_profile_key":"profile-b845fde838c8e0ad18e6a5c29cf6fe2e","send_count":1,"poll_count":63,"goto_count":1,"new_chat_click_count":0,"navigation_count":1,"incidents":[],"cleanup":"confirmed"}
{"schema":"turn-result/v1","state":"recovery_required","scope":"invocation","cause":"capability_probe_incomplete","invocation_id":"550e8400-e29b-41d4-a716-446655440102","configured_profile_key":"profile-b845fde838c8e0ad18e6a5c29cf6fe2e","send_count":1,"poll_count":63,"goto_count":1,"new_chat_click_count":0,"navigation_count":1,"incidents":["capability_probe_incomplete"],"cleanup":"confirmed"}
{"schema":"turn-result/v1","state":"recovery_required","scope":"invocation","cause":"capability_probe_incomplete","invocation_id":"550e8400-e29b-41d4-a716-446655440201","configured_profile_key":"profile-b845fde838c8e0ad18e6a5c29cf6fe2e","send_count":1,"poll_count":60,"goto_count":1,"new_chat_click_count":0,"navigation_count":1,"incidents":["capability_probe_incomplete"],"cleanup":"confirmed"}
{"schema":"turn-result/v1","state":"recovery_required","scope":"invocation","cause":"capability_probe_incomplete","invocation_id":"550e8400-e29b-41d4-a716-446655440202","configured_profile_key":"profile-b845fde838c8e0ad18e6a5c29cf6fe2e","send_count":1,"poll_count":48,"goto_count":1,"new_chat_click_count":0,"navigation_count":1,"incidents":["capability_probe_incomplete"],"cleanup":"confirmed"}
{"schema":"turn-result/v1","state":"recovery_required","scope":"invocation","cause":"capability_probe_incomplete","invocation_id":"550e8400-e29b-41d4-a716-446655440203","configured_profile_key":"profile-b845fde838c8e0ad18e6a5c29cf6fe2e","send_count":1,"poll_count":56,"goto_count":1,"new_chat_click_count":0,"navigation_count":1,"incidents":["capability_probe_incomplete"],"cleanup":"confirmed"}
```

Each capture is exactly:

```json
{
  "probe": "success",
  "invocations": [],
  "results": []
}
```

For the two definitive-no-commit attempts, only the `"probe"` value is
`"definitive-no-commit"`; the `invocations` and `results` arrays are still
empty.
