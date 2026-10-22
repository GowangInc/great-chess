# Great Chess

Play: **https://gowanginc.github.io/great-chess/**

A browser-native, Linework-styled reconstruction of **Tamerlane chess**: 11 files × 10 ranks, two citadels, 28 pieces per side, individual pawn promotions, royal exchanges, and the pawn-of-pawns cycle.

- Single player against an easy or standard bot, calculated in a Web Worker.
- Dedicated **Local** mode for two people sharing one device, with no bot or room required. Solo and Local keep separate automatic device-local saves; changing modes does not replace either game.
- Nineteen hands-on lessons, movement highlights, piece dossiers and a field guide, including the explicitly attributed sheltered-royal return choice.
- Public or password-protected rooms, invitations, saved seats, reconnection, draw offers, resignation and mutual-consent rematches.
- Concurrent isolated rooms per server; independent server hosts selectable in the advanced lobby.
- Authoritative server validation; SQLite persistence; salted scrypt passwords and hashed seat credentials at rest.

## Run locally

Requires Node.js 24+.

```sh
npm ci
npm start
```

Open http://127.0.0.1:9277 . Local clients use the same-origin room service. Solo play and lessons need no live backend after the client files have loaded. Serving the files over HTTP(S) is required for ES modules and the worker; double-clicking `index.html` is not supported.

```sh
npm test
```

`engine.test.js` exercises movement, blocking, royal safety and exceptional rules. `server.test.js` exercises the actual engine through HTTP/WebSocket room contracts, authentication, isolation and persistence.

Verified before release: 57 behavioral checks pass, including immediate citadel draws, optional deployment, checked-only any-friendly exchange, owner-chosen free royal return, promotion-time royal safety, saved-game migration and room-capacity recovery. All 19 tutorial exercises were completed through the rendered board. Two isolated online clients verified that only the owner can choose the return, unsafe squares are unavailable, the placement broadcasts without spending a ply, and the owner's normal turn then continues. The updated bot worker replied legally; same-device Local play and independent saves remain functional.

Local mode was exercised with human moves for both colours, offline play, reload persistence, independent Solo/Local resets, migration of earlier two-player saves, and cancellation/resumption of an in-progress bot calculation. The unnumbered Solo, Local, Online rooms and Learn navigation fits 320px, 390px and desktop widths.

## Hosting

### GitHub Pages frontend

Publish the repository's `main` branch, root directory, through GitHub Pages. There is no build step. `index.html` loads only browser-native modules. No password, seat credential, database or tunnel credential belongs in Git.

`config.js` lists named HTTPS room services. The built-in lobby uses the first entry; independent hosts can add an endpoint without modifying the engine or interface. Invitations carry a room ID and, for an independent host, its endpoint. They never carry a seat token or password. Share room passwords separately.

### Persistent room server

`server.js` runs independently of GitHub Pages. The production deployment uses Docker Compose and a dedicated named Cloudflare Tunnel. Public DNS resolves to Cloudflare, not the origin, and the game server binds only to host loopback. No inbound public game port or machine hostname is required.

1. Create your own named Cloudflare Tunnel and a proxied hostname in your zone.
2. Adapt `tunnel-config.yml` to that tunnel UUID and hostname; retain `http://server:9277` as its upstream.
3. Place the scoped tunnel credential at `tunnel-credentials.json` on the deployment host only, mode `600`. This file is excluded from Git and Docker build context. Do not copy an account-wide certificate into the container.
4. Set `ALLOWED_ORIGINS` to your frontend origin if different from this deployment.
5. Start:

```sh
docker compose up -d --build
```

The server runs unprivileged with a read-only root filesystem. Its writable SQLite files live in the `great-chess-data` volume; preserve and back up that volume when updating. The tunnel container uses only its dedicated tunnel credential. Compose automatically restarts both services. Updates rebuild the app container without replacing the data volume.

For another independently hosted server, use another deployment directory/Compose project, a separate persistent volume, its own tunnel/hostname and a different free host-loopback port. Add its public HTTPS endpoint under **Independent room servers**. Each server maintains its own room list; rooms are not federated between servers.

Supported server environment variables:

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1`; Compose uses `0.0.0.0` inside its private container network |
| `PORT` | `9277` |
| `DATA_DIR` | `./data`; Compose uses persistent `/data` |
| `ALLOWED_ORIGINS` | Comma-separated trusted frontend origins; loopback origins also allowed for local development |
| `TRUST_PROXY` | Set `1` only behind a trusted proxy; Compose trusts Cloudflare's client-IP header |
| `MAX_ROOMS` | `200` concurrent unfinished matches/recent waiting rooms; retained finished games do not consume slots |

API: `GET /api/health`, `GET/POST /api/rooms`, `POST /api/rooms/:id/join`, authenticated `GET /api/rooms/:id`, authenticated `POST /api/rooms/:id/action`, and `/ws`. Seat authentication uses a bearer token, sent in a WebSocket subscription frame rather than the URL. Moves include `expectedPly` and are revalidated against the shared engine. A room password controls entry; an issued seat token reconnects that seat without entering the password again. Losing device storage loses that seat credential. Password-protected room names and occupancy remain visible in the lobby; boards require seat authentication.

Finished rooms leave the public lobby and release their capacity slot without deleting their game state or seat credentials. One-seat waiting rooms leave the lobby after 24 hours and also release capacity; saved seats and direct invitations still work. Rejoining an aged waiting room or starting a mutually agreed rematch requires an available slot. Two-seat unfinished matches are preserved regardless of age. Retained room history remains in SQLite and is loaded into memory at startup; for very large archives, move historical-room reads to a bounded lazy cache before increasing deployment scale.

## Historical basis and reconstruction

The game is associated with Timur's court, but that does not prove that Timur personally invented it or that ordinary chess was “too easy.” “Great Chess” also names other historical large-board variants. This edition follows **Hans Bodlaender's base-game Tamerlane account on The Chess Variant Pages**, not Eric Greenwood's modern variants or Great Chess Completed.

Sources consulted:

- [Hans Bodlaender, *Tamerlane chess*, The Chess Variant Pages (1996; revised 2003)](https://www.chessvariants.com/historic.dir/tamerlane.html): canonical base rules, supplied in full by the user when automated access returned HTTP 403. The page's general is the ferz; its war engine is the engine.
- [Greg Myers, *The Rules of Tamerlane Chess* (2017)](https://tamerlaneschess.wordpress.com/2017/03/24/the-rules-of-tamerlane-chess/): alternate reconstruction and discussion of manuscript ambiguities; not the selected ruleset.
- [Diana Mihajlova, *Tamerlane Chess revived!* (ChessBase, 2023)](https://en.chessbase.com/post/tamerlane-chess-revived): interview, manuscript provenance and movement descriptions.
- [*Great chess* / Tamerlane chess overview](https://en.wikipedia.org/wiki/Tamerlane_chess): cross-check of setup, promotions, citadels and royal hierarchy.

Entering the opponent's citadel draws immediately. Qualifying pawn-of-pawns redeployment is optional. The once-only king exchange requires check and can use any friendly piece, subject to citadel restrictions and royal safety. Stalemate loses; no castling, initial pawn double step, en passant, bare-king loss, automatic repetition draw or fifty-move draw. Square shading is a readability aid; historical boards were unchequered.

Bodlaender explicitly **invented** the rule allowing the owner to choose an empty return square when a sheltered adventitious king becomes the last royal. This is not claimed as an attested manuscript rule. This edition applies normal last-royal safety to that choice: an empty, unattacked square on the main board. The return is immediate, without another ply or a spent turn; it is not an automatic return to a home square.

The source does not resolve a royal occupying f3/f8 when the pawn-of-pawns makes its second arrival. The existing explicit completion is retained: wait on the last rank, immune, until the royal vacates, then return without another move. The interface's **History, sources & the rules we play** section includes the precise `RULE_NOTES` and marks these edge interpretations. Older saved games already awaiting a citadel declaration are upgraded to a draw without deleting their board, ledger, or seat credentials.

All piece illustrations are original SVG drawings. The design studies the ruled-oval geometry of the illustrated *Cerîde-i Adliye* covers; no reference scans or inscriptions are redistributed.
