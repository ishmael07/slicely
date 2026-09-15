# Deploying Slicely to an Oracle Cloud Always-Free VM

Oracle's Always-Free tier includes an Ampere (arm64) VM with 4 cores, 24 GB of RAM
and 200 GB of disk, free for as long as the account exists — not a trial. That is more
than the app needs (headless PrusaSlicer wants ~2 GB), it is persistent, and it is
always on, which the streaming chat depends on. This guide goes from nothing to a
running app at `https://<your-host>` in about twenty minutes, most of it Oracle's UI.

Everything in `deploy/oracle/` is what runs: `compose.yml` (the app plus Caddy for
HTTPS), `Caddyfile`, `.env.example`, and `setup.sh` for the one-time VM setup. The same
files work on any Docker host, amd64 or arm64.

## 1. The VM

1. Sign up at cloud.oracle.com (a card is required for identity; the free tier is not
   charged). Pick the home region carefully — it cannot change later, and free Ampere
   capacity varies by region.
2. **Compute → Instances → Create instance.**
   - Image: **Ubuntu 24.04** (Canonical, aarch64).
   - Shape: **Ampere → VM.Standard.A1.Flex**, 4 OCPUs, 24 GB — the whole free allowance
     in one machine. If Oracle says *Out of host capacity*, retry later or try another
     availability domain; it is a known nuisance, not a mistake on your side.
   - Boot volume: up to 200 GB is free; 100 GB is plenty.
   - Networking: create a new VCN with a **public IPv4**. Save the SSH key it generates.
3. **Open the ports.** VCN → Subnet → *Default Security List* → *Add Ingress Rules*:
   source `0.0.0.0/0`, TCP, destination ports **80** and **443**. (The instance's own
   iptables also blocks them; `setup.sh` handles that half.)

## 2. A hostname

Caddy gets a real certificate automatically, but it needs a name pointing at the VM.
Free and instant: [duckdns.org](https://www.duckdns.org) — sign in, create a subdomain
such as `slicely.duckdns.org`, set its IP to the VM's public IP. Your own domain works the
same way with an `A` record.

## 3. Setup

SSH in (`ssh -i <key> ubuntu@<public ip>`) and run the setup script:

```bash
git clone https://github.com/ishmael07/slicely.git && bash slicely/deploy/oracle/setup.sh
```

The first run installs Docker, opens ports 80/443 in the instance firewall, and stops to
let you fill in `~/slicely/deploy/oracle/.env`. The minimum:

```bash
SLICELY_HOST=slicely.duckdns.org
SLICELY_PUBLIC_URL=https://slicely.duckdns.org
SLICELY_MASTER_KEY=<output of: node scripts/gen-master-key.mjs>   # generate on your Mac
```

The sourcing keys and the sign-in / free-credit block are the same optional set as in
[`DEPLOY.md`](DEPLOY.md) and `.env.example` at the repo root; leave any of them blank and
that feature is simply off. Then run the script again:

```bash
bash ~/slicely/deploy/oracle/setup.sh
```

It builds the image (five to ten minutes the first time — the arm64 build installs
Debian's `prusa-slicer` 2.9.2 from apt, since Prusa ships no arm64 Linux build) and
starts both containers. The build ends with the same slice smoke test the Fly image
runs, as the runtime user, so a slicer that cannot run fails the build, not a visitor.

Check it:

```bash
docker compose -f ~/slicely/deploy/oracle/compose.yml logs -f app   # boot log; ^C to leave
curl -s https://slicely.duckdns.org/healthz                          # → ok
curl -s https://slicely.duckdns.org/api/config | head -c 300         # mode, providers, commit
```

If `https://` fails for the first minute, Caddy is still getting its certificate; the
`caddy` container's log says so.

## 4. Point the site at it

`site/config.js` → `APP_URL`, and the three matching `href`s in `site/index.html` (they
must agree — `site/main.js` warns in the console when they don't). If sign-in is on,
also update the redirect URIs in the Google and GitHub OAuth apps to
`https://<host>/auth/google/callback` and `https://<host>/auth/github/callback`.

## Updating

```bash
cd ~/slicely && git pull && SOURCE_COMMIT=$(git rev-parse HEAD) \
  docker compose -f deploy/oracle/compose.yml up -d --build
```

Data lives in the `slicely_data` volume and survives rebuilds; only `docker compose
down -v` deletes it. `SOURCE_COMMIT` is what `/api/config` reports and the footer links
to — the app is AGPL (PrusaSlicer), so pass it (see `src/server/LICENSING.md`).

## What to know about one VM

- **Backups are yours.** Oracle can snapshot the boot volume (Block Storage → Boot
  Volumes → Create backup); the free tier allows a few. `slicely_data` is on that volume.
- **Idle reclamation.** Oracle reclaims Always-Free instances it considers idle
  (under ~20% CPU/network for a week, on accounts with no paid usage). A running Slicely
  with occasional traffic is fine; a forgotten one can be stopped. Upgrading the account
  to Pay-As-You-Go (still $0 while inside the free limits) removes the rule.
- **Memory.** `compose.yml` caps the app at 4 GB; the slicer has never needed that, but
  the VM has 24 GB to give if a model does.
