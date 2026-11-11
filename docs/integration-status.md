# Integration status reads

The registry is read for every integration list, using the caller's tenant and
source visibility rules. Provider job and stream measurements are display data;
they never authorize access or override the current registry lifecycle state.

Status refreshes run independently of the response, at most once per connection
per five seconds. Concurrent readers share the refresh. Keys include environment,
tenant, owner, integration and Airbyte connection. The bounded cache retains recent
measurements after failure, with explicit unavailable metadata; measurements older
than five minutes are withheld. Failure retries use the same five-second interval.
Retry/disconnect invalidate status, and an old in-flight completion cannot republish
an invalidated entry. Cold reads show a connected source with unknown measurements,
never a fabricated zero count or running import. Visible pages poll normally and
pick up the refreshed snapshot.

Distinct counts warm alongside background status. Their existing durable snapshot
is published before scanning newly landed objects; neither provider status nor a
raw-data recount blocks the page. This behavior is shared by the self-hosted and
hosted adapters and requires no OpenCrawl-managed service or account.
