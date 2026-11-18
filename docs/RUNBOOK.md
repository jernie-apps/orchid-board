# Orchid Board on the Mac

The board listens on `127.0.0.1:4310` by default. The Caddy LaunchAgent terminates TLS at `https://orchid.jernie.app` and forwards only to the web listener. MCP stays on `127.0.0.1:4311` and has no Caddy route. Use the checkout that includes the web board (#10); without that listener, Caddy can start but the URL returns `502`.

## Install

1. Log into the Mac desktop as the account that will run the board. Keep the repository in a permanent location owned by that account, not a temporary worktree.
2. Install Caddy with Homebrew and use Node 22.18 or newer. For example, from the repo:

   ```sh
   brew install caddy node@24
   export PATH="$(brew --prefix node@24)/bin:$PATH"
   npm ci
   ```

   Do not start a second Caddy with `brew services`. The installer records the absolute paths of `node` and `caddy`; rerun it after moving the checkout or switching installations.
3. Run `mkdir -p "$HOME/.orchid/board"` and `chmod 700 "$HOME/.orchid/board"`. Put this example in `~/.orchid/board/config.json`, adjusting the repo list as needed:

   ```json
   {
     "repos": ["companie-apps/orchid-board"],
     "port": 4310,
     "mcpPort": 4311,
     "pollSeconds": 60
   }
   ```

   Store the GitHub credential, MCP credential, and web login passphrase in `github.token`, `mcp.token`, and `web.passphrase` respectively, one value per file. Create each missing file with mode `600` before adding its value, then verify permissions (or apply them to existing files):

   ```sh
   chmod 600 "$HOME/.orchid/board/"{github.token,mcp.token,web.passphrase}
   ```

   Keep values out of your shell history and the repo. The installer checks only the files' existence, type, and mode. It validates `config.json` and sets Caddy's upstream from `port`; rerun the installer after changing that port. Do not use port `443` for either app listener or set both to the same port.
4. Preview, then install and start both agents:

   ```sh
   ./scripts/install-launchd.sh install --dry-run
   ./scripts/install-launchd.sh install
   ```

   Both are per-user LaunchAgents: they start at login (including the first login after a reboot) and restart if they exit. They do not run before login. This Mac allows a non-root process to bind wildcard TCP `443`, so Caddy can listen for the iPhone without a root daemon or `pf` rules. Keep the wildcard listener; do not replace it with a bind to a specific privileged address. If the Mac's firewall prompts for Caddy, allow incoming connections on the trusted LAN. Do not forward TCP `443` from the internet. The Caddyfile only proxies loopback, RFC 1918 IPv4, and ULA IPv6 clients; run it only on trusted networks, or narrow the `@local` ranges to your home subnet plus loopback.

## Local DNS And Trust

1. Reserve a fixed DHCP lease for the Mac in the home router. Use the Mac's actual LAN IPv4 address everywhere; `192.168.1.23` below is only an example.
2. On the Mac, add this line to `/etc/hosts` manually. On the router or local DNS resolver, add a local A record for `orchid.jernie.app` to the same IP and make sure the iPhone uses that resolver on home Wi‑Fi. Do not change public DNS, Cloudflare, or Squarespace. The scripts never edit `/etc/hosts`.

   ```text
   192.168.1.23 orchid.jernie.app
   ```
3. Once Caddy has started, preview and run the trust script. Check the root certificate's subject and SHA-256 fingerprint before typing `yes`. Only that confirmation runs `sudo` to trust the root for SSL in the Mac's System keychain. Caddy never attempts to install trust itself.

   ```sh
   ./scripts/setup-tls.sh --dry-run
   ./scripts/setup-tls.sh
   ```
4. AirDrop only `~/.orchid/board/orchid-board-root.crt` to the iPhone. Open the downloaded profile in Settings and tap **Install**. Then go to **Settings ▸ General ▸ About ▸ Certificate Trust Settings** and enable full trust for this root. Never copy the Caddy data directory or a CA private key to the phone.
5. Open `https://orchid.jernie.app` on both devices without bypassing certificate warnings. On the Mac, `curl -I https://orchid.jernie.app` also checks DNS and system trust; to isolate a DNS failure, add `--resolve orchid.jernie.app:443:127.0.0.1`. Reboot, log back into the Mac, and verify the URL again. Agents cannot serve the phone while the Mac is asleep.

## Start, Stop, And Logs

- Start or refresh both jobs: `./scripts/install-launchd.sh install`. It validates both configurations before stopping existing jobs and is safe to rerun. This is also how to apply Caddyfile changes; Caddy's admin API is disabled.
- Stop until the next login without removing plists: run `launchctl bootout "gui/$UID/com.orchid-board.caddy"` then `launchctl bootout "gui/$UID/com.orchid-board.board"`. An already stopped job may report that it was not found.
- Inspect with `launchctl print "gui/$UID/com.orchid-board.board"` or `launchctl print "gui/$UID/com.orchid-board.caddy"`.
- Logs are `board.out.log`, `board.err.log`, `caddy.out.log`, and `caddy.err.log` under `~/.orchid/board/logs`. Use `tail -f "$HOME/.orchid/board/logs/"*.log`; check Caddy's error log for port conflicts or the board's error log for startup errors. Stop the jobs before moving/truncating logs, then start them again.

## Rotate Credentials

Replace the relevant value in its credential file without changing mode `600`, then run `launchctl kickstart -k "gui/$UID/com.orchid-board.board"`. Update affected MCP clients or sign in with the new web passphrase. Verify the new credential works, then revoke the old token if the issuer supports revocation. Credential rotation does not require changing TLS trust.

## Uninstall

```sh
./scripts/install-launchd.sh uninstall --dry-run
./scripts/install-launchd.sh uninstall
```

This stops the agents and removes their plists. It leaves board data, logs, Caddy's CA, and device trust unchanged so reinstalling can reuse the same CA. To retire the board, manually remove the hosts line and router DNS override. In Mac Keychain Access, locate the root in **System**, verify its fingerprint against the exported certificate, and remove it. On the iPhone, remove the installed CA profile under **Settings ▸ General ▸ VPN & Device Management**. Remove the board state directory only if you no longer need the database, credentials, or CA.
