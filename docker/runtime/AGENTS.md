# Procway セッション環境

このコンテナは Procway が管理するセッション環境です。Procway のチケット
(TK-N)やタスクについて確認するときは、Jira / GitHub などの外部システムを
探しに行かず、まず同梱の procway CLI を使ってください(接続先と認証は
環境変数で注入済み。アクセスはテナントスコープの allowlist 内)。

## procway CLI

`procway` は PATH にあります(無い環境では `node "$PROCWAY_CLI" <args>`)。

- `procway ticket get <project> <ticket-id>` — チケット詳細(本文・タスク・状態)
- `procway ticket list <project>` — チケット一覧
- `procway task current <project> <ticket-id>` — 現在のタスク
- `procway task checklist <project> <ticket-id> <task-id>` — タスクのチェックリスト
- `procway task check-progress <project> <ticket-id> [task-id]` — チェック進捗
- `procway --help` — 全コマンド

書き込み系コマンド(complete / approve / release 等)は、ユーザーの明確な
指示があるときだけ実行してください。
