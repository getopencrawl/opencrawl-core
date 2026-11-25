---
name: oc-share
description: Return the OpenCrawl link to this chat for viewing or handoff with oc-continue.
---

Use this chat’s native `currentSession`. Call `opencrawl_browse` with that identity, `source="sessions"`, its `sessionId`, `filters.harnesses=[harness]`, `includeCurrentSession=true`, `groupBy="session"`, and `select=["provenance"]`. If the capture is missing or ambiguous, say so.

Return only `<configured OpenCrawl origin>/sessions?user=<userId>&harness=<harness>&id=<sessionId>` using the matching provenance and URL-encoding each value.
