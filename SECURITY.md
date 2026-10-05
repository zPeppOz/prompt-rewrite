# Security policy

Only the latest release of prompt-rewrite gets security fixes.

To report a vulnerability, use GitHub's private reporting: [open a draft security advisory](https://github.com/zPeppOz/prompt-rewrite/security/advisories/new). Please don't open a public issue. Expect a first reply within a week.

prompt-rewrite runs inside omp or Claude Code with the same permissions as the host. It sends your draft and the current conversation to the model configured in your session (or the one you picked for `/rewrite`) and never executes tool calls. In Claude Code it hooks only `AskUserQuestion` tool calls, and only to put its own questions in the dialog it opened; `claude plugin validate .` lists every event and call it uses. Report issues in the hosts to [oh-my-pi](https://github.com/can1357/oh-my-pi/security) or [Claude Code](https://github.com/anthropics/claude-code/security).
