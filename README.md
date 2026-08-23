# FAV DOWN

Pings your phone (ntfy) when a pregame MLB favorite falls behind.
GitHub Actions cron · zero deps · state committed as `state.json`.

## Ship it

```
gh repo create favdown --public --source=. --push
gh secret set NTFY_TOPIC -b "favdown-3465244b"        # or pick your own unguessable topic
gh workflow run favdown -f test=true                   # smoke test -> phone should buzz
```

Phone: install the ntfy app, subscribe to the same topic. Done.

## Controls (repo variables)

- `FAVDOWN_KILL=1` — kill switch
- `FAVDOWN_REPING=0` — mute deficit-grew pings
- `FAVDOWN_RECOVERY=0` — mute comeback pings

## Notes

- Polls every 5 min, noon–3 AM ET (covers day games through late West Coast).
- GitHub cron drifts: alerts can lag 5–15 min behind live.
- Public repo = free Actions minutes; private burns ~5k min/month at this cadence.
- Morning runs cache each game's pregame line before ESPN drops odds at first pitch.
- `node test.js` — 17 offline tests for the parser and alert engine.
