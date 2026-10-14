# Upstream sources

- `vcmi/` is vendored from https://github.com/vcmi/vcmi tag `1.7.5` (commit `6901839ae9760dfcd1d5ff2c4aa4ef6968fee752`).
- `vcmi/AI/FuzzyLite` is vendored from https://github.com/fuzzylite/fuzzylite (commit `13b3122f5c353c0389ed4e66041d548c44ec9df6`).
- Unused submodules (googletest, innoextract, discord-presence, dependencies) were dropped.

The first commit in this repository contains the pristine upstream tree; every later change to
`vcmi/` is part of the browser port.
