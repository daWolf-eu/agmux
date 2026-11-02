# Rex behaviour findings (2026-11-02)

Measured on Rex server `0.0.1793299046-g2307b7`, app Rex Beta 0.1.0 (1696), macOS, in one throwaway session (`agmux-spike`, killed afterwards). Floats were created with `session.new_layer`, since keys can't be pressed from an agent.

## R1: tail read on long scrollback. PASS (p95 50 ms)
- `rex block call format '{"format":"text","max_bytes":4096}'` returns `{content, id, total}`. `content` is the HEAD of the scrollback (first ~4 KB), not the tail. `id` appears only when more remains. `total` is the byte length of the whole text.
- `blob_read` takes `{id, offset, max_bytes}` (all optional; id 0 or missing means the newest result; max_bytes counts the JSON-encoded string, default 48 KiB, cap 960 KiB). It returns `{id, data, total, eof}`.
- Scrollback of 4,271,436 bytes (100k lines of 80 chars): `format` p95 50 ms (41-50), `blob_read` at `total-65536` p95 32 ms, 10 runs each, each as a separate `rex` process (includes process start).
- With 700k short lines the retained text was only 672,179 bytes, so scrollback is capped by lines (about 96k) rather than bytes; wider lines gave 4.1 MiB.
- Asking for 65536 bytes at `total-65536` returned 57,344 or 64,096 bytes with `eof:false`. The reader must loop until `eof`.
- The `format` result id is kept ~5 minutes.

## R4: endpoint. PASS
`rex -S "$REX_SERVER" --autostart=false ls --json` works with the `unix://...%20...` value. Shape: `{"sessions":[{"session_id","label"}]}`. Exit codes: present 0, gone session/block 3, unreachable server 4. `rex block inspect` and `rex focus` need `-s` when the target block is not in `$REX_SESSION`.

## R5: argv. PASS without `--shell=none`
`rex window new --json -- /bin/sh -c 'printf "<%s>\n" "$@"; sleep 30' x 'a b' ';' '{"k":"v w"}'` printed `<a b>`, `<;>`, `<{"k":"v w"}>`. Everything survives. With `--shell=none` the same argv also survives, but PATH is `~/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:` plus cryptex and Rex app dirs, with no `/opt/homebrew/bin` or nvm. The default (login shell) PATH is the full one. `REX_SESSION`, `REX_BLOCK`, `REX_SERVER`, `REX_BIN_DIR` are set in both. A block whose program exits is closed at once and its id becomes "not found" (so wrappers need a hold on failure).

## JSON shapes (for later tasks)
- `rex new NAME --json`: `{"session_id","initial_windows":[{"window_id","block_ids":["block:.."],"revision"}]}`
- `rex window new --json -- cmd` and `rex run --json -- cmd`: `{"window_id","block_ids":["block:.."],"revision"}`
- `rex split --json -- cmd` and `rex run --split=right --json`: `{"anchor_id","block_ids":[..],"split_ids":["split:.."],"revision"}`. `--split` takes a direction value (`--split=right`); a bare `--split` swallows the next flag.
- `rex run --label L --json`: the label is NOT echoed. Ids only (`window_id`, `block_ids[0]`). The label shows as `label` in `rex block ls --json` and `session inspect` blocks. Default label is `shell`.
- `rex run --wait --json`: prints the creation result, then exits with the child's exit status (3 for `exit 3`) and `Error: exit status 3` on stderr.
- `rex block ls -s S --json`: `{"blocks":[{block_id,label,creator_name,flavor,host_id,placement,window_id,owner?}]}`.
- `rex api call -s S block.event -` with stdin `{"session_id","block_id","event":{"type":"paste","payload":{"text":...}}}` returns `{}` and exit 0. Pasting 20,400 bytes of multi-line text (200 lines with quotes, backslashes, `$`, backticks, `;|&`, non-ASCII) into `sh -c 'cat > file'` produced a byte-identical file. Lines were under 1 KiB each; a single line over the tty's 1024-byte canonical limit was not tested (needs manual check if it matters).
- `session.new_layer` input: `{session_id, window_id?, bounds:[x,y,w,h], focus, layout:{block:{flavor, label, options:{command:[..], shell:"none"}}}}`; returns `{layer_id, block_ids, revision}`.

## R6, R7: floats
- Inside a float, `$REX_BLOCK` IS the float's block id and `$REX_SESSION` is the session. No `TMUX*` variables.
- `rex session inspect` shows the float as a layer `kind:"floating"` and the window's `focused_block_id` is the float (when created with focus true). The tiled layer is `kind:"tiled"` with its `blocks`. The block's window is `.block.window_id` in `rex block inspect`.
- `owner`: the float block had NO `owner`. In my throwaway session no app was attached; the clients list showed the app (`Rex Beta`, connected, but owning none of my blocks) and the CLI. The first tiled block had `owner: client:...5314...`, a CLI client that no longer existed (the one that ran `rex new`), while later tiled blocks had none. In the user's own app-attached sessions every block, including a `scratch` block, has `owner` = the app's client id. Whether a float in an app-attached session has an owner: needs manual check.
- Focus: from inside the float, `rex focus <tiled>` moves focus to the tiled block, and after the float exits focus stays there. If the float exits without that, focus does NOT return to the previously focused block. With tiled blocks B (focused), T2, T3 (newest), closing a float always left focus on T3, the most recently created tiled block, whether B or T2 had been focused before. A float created with `focus:false` leaves focus alone.

## L4: TMUX. PASS
No `TMUX` in Rex blocks (default shell, `sh -c`, float). `TERM=xterm-256color`, `TERM_PROGRAM=rex`. So `detectMux` by `TMUX` then `REX_BLOCK` is sound.

## R2: title polling. PASS
20 sequential `rex block call title`: 26-30 ms each, 554 ms total, mean 28 ms. No lower bound on the poll interval from this; 500 ms is fine.

## Needs manual check (for the final smoke test)
1. Owner of a float's block in a session an app is attached to, and `session.select` of that owner.
2. The real float key (`init.lua`), as opposed to `session.new_layer`: same `REX_BLOCK`/focus behaviour expected.
3. A single pasted line longer than 1024 bytes into a non-bracketed-paste program.
