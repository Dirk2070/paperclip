# Verification skills provenance

These skills come from Paperclip's portable pstack fork in
`paperclipai/agent-plugins`, commit
`410257663e0b344df656e604f1601aa1db95f7e4`, under `vendor/pstack/`.
That fork imported pstack 0.15.15 by Lauren Tan (poteto) from
[cursor/plugins](https://github.com/cursor/plugins/tree/ccb5507cec1546dc88135c1139c811e6c59115ba/pstack),
upstream revision `ccb5507cec1546dc88135c1139c811e6c59115ba`.
The original [MIT license](LICENSE) is preserved verbatim.

The imported package consists of `create-verification-skill`,
`maintain-verification-skill` in `.agents/skills/`. It includes both invocation-policy files and all three
feature-map example files. They are ordinary repository files, with no
dependency on a developer's personal skill installation or symlinks.

Paperclip packaging changes:

- Both workflows use Paperclip's existing repo-root `feature-map/` directory.
  New or updated entries follow Poteto's bundled feature-map examples.
- Explicit invocation remains configured in each verification skill's
  `agents/openai.yaml`. The redundant Cursor-specific
  `disable-model-invocation` frontmatter field is removed.
- Paperclip supplies the execution runtime. The fork's separate `runtime` skill
  and the verification skills' references to it are omitted.
- No upstream Cursor built-in skills are redistributed. Browser/CLI tooling,
  model configuration, provider credentials, and scheduling remain host
  capabilities discovered when needed. A project-specific verification skill
  is generated or supplied by the target project.

The [import manifest](import.json) records source and installed hashes for every
packaged file. Copy complete directories from the portable fork when refreshing
this subset; preserve the local packaging adaptations and validate every relative
reference.
