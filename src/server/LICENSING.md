# Licensing note — read before deploying this server publicly

Slicely's slicing is done by shelling out to the **PrusaSlicer CLI**
(`src/main/prusaslicer.ts`). PrusaSlicer is licensed under the **GNU AGPLv3**.

On the desktop (the Electron app), PrusaSlicer runs as a separate local
process on the user's own machine. Nothing about that arrangement triggers
AGPL's network-use clause, because there is no network interaction between
Slicely and any third party — it's one person's app talking to one binary on
their own disk.

This `src/server/` layer changes that shape: it runs PrusaSlicer **as a
network service**. The AGPL's defining term (section 13, the "Remote Network
Interaction" clause) is triggered specifically by that: if you run a modified
version of an AGPL program and let users interact with it **remotely over a
network**, you must offer those users the **complete corresponding source**
of the version you're running — not just PrusaSlicer's own source (which is
already public), but, per the letter of the clause, the source of the running
combined work they are interacting with, including the modifications and the
surrounding program that invokes it.

What this means in practice, and what it does **not** mean:

- It does **not** mean Slicely itself must be AGPL-licensed. Slicely invokes
  the PrusaSlicer binary as a separate CLI process (not by linking its code),
  which is a materially different relationship than compiling against it.
- It **likely does** mean that anyone who can reach this server over a
  network and cause it to invoke PrusaSlicer is a "user interacting with [it]
  remotely through a computer network" under AGPL §13, and is therefore
  entitled to a source-code offer for the AGPL-covered program as deployed
  (including PrusaSlicer's own source, which PrusaSlicer's own license
  already requires be available, and arguably the glue code that constitutes
  "the Program" as run).
- Bundling/redistributing the PrusaSlicer binary itself with this server
  (rather than requiring it be installed separately) raises the same
  obligation independent of anything above, since redistributing the AGPL
  binary is itself covered by the license regardless of how it's invoked.

**This is not legal advice, and it is a real, non-trivial obligation** — not
a formality to wave off. The two safe paths, roughly:

1. **Comply**: make the source of this server (this repo, as deployed)
   available to anyone who uses the hosted slicing feature — e.g. a visible
   "Source" link served by the app itself, pointing at the exact commit
   running in production, kept in sync on every deploy.
2. **Avoid triggering it**: don't run PrusaSlicer server-side. Options include
   keeping slicing client-side/desktop-only and using this server only for
   sourcing/chat/printer-transport features, or swapping in a slicing engine
   with a license that doesn't carry the network clause.

**The decision of which path to take belongs to the repo owner**, not to
this implementation. Nothing in `src/server/` has been engineered to route
around AGPL §13 (there is no attempt to keep the PrusaSlicer CLI invocation
"secretly" server-side while pretending otherwise) — it is a direct, visible
reuse of `main/prusaslicer.ts`, exactly as instructed. Whoever operates a
public instance of this server needs to make the compliance call above
before doing so.
