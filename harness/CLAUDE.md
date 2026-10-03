<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# WhatsApp Inbox workspace

This folder is the workspace of the WhatsApp Inbox plugin's case agent. Read `AGENTS.md`
first: it holds the rules that beat everything else. You propose on a case and never send
anything on WhatsApp.

When you are told to handle a case, the plugin gives you ONE case in a file
(`casos/caso-<id>.md` in the plugin's data folder): read it and follow the
`whatsapp-soporte` skill, which holds how a case is worked, step by step.

- `.claude/skills/whatsapp-soporte/SKILL.md`: the support playbook (tone, escalation,
  voice notes, attachments, how to write a brief).
- `.claude/skills/whatsapp-cli/SKILL.md`: the real commands and flags.
- `COMMANDS.md`, `CLASSIFICATION.md`, `EXAMPLES.md`, `PROJECTS.md`: the reference.
- `.wa-bin`: the path of the tools' `bin/`, one line.
