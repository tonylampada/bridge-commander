Refresh tokens expire mid-session and the UI silently logs the user out.

## Repro

1. Sign in, wait 55 minutes.
2. Any API call → 401 → hard redirect to login. Unsaved state lost.

## Plan

- [ ] Refresh 5 min before expiry (worker timer, not per-request)
- [ ] Single-flight the refresh call (dedupe concurrent 401s)
- [ ] Retry the failed request once after a successful refresh

```js
// sketch: single-flight refresh
let inflight = null;
async function freshToken() {
  inflight ||= doRefresh().finally(() => (inflight = null));
  return inflight;
}
```

Relevant: [RFC 6749 §6](https://datatracker.ietf.org/doc/html/rfc6749#section-6)
