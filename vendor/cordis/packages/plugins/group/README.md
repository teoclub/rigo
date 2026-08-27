# @teoclub/cordis-plugin-group

Loader group plugin for nesting Cordis entries.

## Usage

```yaml
- id: tools
  name: '@teoclub/cordis-plugin-group'
  group: true
  config:
    - id: logger
      name: '@teoclub/cordis-plugin-logger-console'
```

Groups are always considered enabled themselves, but disabling a group entry
prevents its child entries from running. Nested entry ids use `:` separators,
for example `tools:logger`.

The package re-exports the `Group` implementation from
`@teoclub/cordis-plugin-loader` as its default plugin.
