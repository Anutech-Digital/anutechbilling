# Playbooks

A playbook is the method, hard rules and lessons for one kind of repeated hands-on run
(for example a bank reconcile in the browser). It is generic: no customer names, GSTINs,
amounts or staging ids — real cases are written as types ("a customer whose base was paid
before go-live").

- **Every worker reads the relevant playbook first**, before the first click of the run.
- **The observer appends lessons after each run** (R-2169): it reviews the run's liveLog,
  report and the app's own logs, then adds new lessons to the playbook's lessons log through
  a normal card push (`worker-lock push`). Because playbooks live in git, every teammate's
  Claude gets the same lessons.
- A lesson that is really an app bug goes on the right card as a gap; the playbook only
  says how to work around it until the fix ships.

| Playbook | For |
|---|---|
| [RECONCILE.md](RECONCILE.md) | Bank money-in reconcile against Zoho Books on staging |
