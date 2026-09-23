# Security

Tater's Flight Sim is a static web page: it has no server, accounts or stored personal data, and it
loads nothing from the network at runtime. The most likely security issues are in the development
tooling (dependencies) rather than the game.

## Reporting a problem

Please **don't open a public issue** for a security problem. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's **Security** tab). Include what you found, how to
reproduce it and what it affects. You'll get a reply as soon as the maintainer can manage — this is
a hobby project, so please allow a few days.

Only the latest version on the default branch is supported.

## Scope

In scope: the game code in `src/`, the production build it ships as, the scripts in `scripts/`,
and the GitHub Actions workflows in `.github/workflows/`. Vulnerabilities in a dependency are
best reported upstream too; tell us as well if the way this project uses it makes things worse.
The game has one runtime dependency (three.js) and loads nothing from the network, so anything
that makes it fetch or run outside content is worth reporting.
