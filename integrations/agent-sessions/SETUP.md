# Set up agent session capture

A runbook for a coding agent (Claude Code, Codex, Gemini CLI, Cursor, ...) setting
up OpenCrawl agent session capture for the person it works with. People can follow
it too. Run commands from the repository root.

The goal: a receiver running in Docker on this machine, landing every agent
transcript in an S3 bucket the user chose, and a collector on this machine
uploading to it.

## Ground rules

- Ask before you create anything in the user's AWS account, and show them exactly
  what will be created.
- Never ask the user to paste AWS secret keys, passwords or tokens into the chat.
  Sign-in happens in their browser or their own terminal. `s3-setup.mjs` writes
  keys straight to `.env` and never prints them. Do not print `.env`.
- Each command below prints JSON. Read `next`, `error` and `reason` and follow the
  matching step. Do not guess.
- If the user only wants to try OpenCrawl and has no AWS account, offer the local
  development store instead: `integrations/agent-sessions/local.sh up --bundled-s3`,
  then go to step 5.

## 1. Prerequisites

Check `docker info` and `node --version` (20 or newer). If Docker is missing or
not running, ask the user to install or start Docker Desktop (macOS, Windows) or
Docker Engine (Linux). If Node is missing, offer to install it, for example with
`brew install node` on macOS.

## 2. Check AWS access

```sh
node integrations/agent-sessions/s3-setup.mjs check
```

| `next` | Do this |
| --- | --- |
| `start-receiver` | `.env` already names a bucket. Tell the user which one and go to step 5, unless they want to change it. |
| `choose-bucket` | Signed in. Tell the user the `account` and `identity` you will act as, then go to step 3. |
| `sign-in` | Go to "Signing in" below, then rerun `check`. |
| `install-aws-cli` | Ask the user for permission to install the AWS CLI v2 (macOS: `brew install awscli`; Linux and Windows: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then rerun `check`. |

### Signing in

Ask the user how they sign in to AWS, then use the matching route:

- **IAM Identity Center (SSO), already set up in `~/.aws/config`:** run
  `aws sso login --use-device-code --no-browser` (add `--profile <name>` when they
  use one). Show the user the URL and code it prints, and wait for the command to
  finish.
- **IAM Identity Center, not set up yet:** ask for their start URL and SSO region,
  then ask them to run `aws configure sso` in their own terminal. It prompts for
  account and role choices.
- **Console password, or no idea:** ask them to run `aws login` in their own
  terminal. It signs in through the browser and needs no keys.
- **Long-lived access keys:** ask them to run `aws configure` in their own
  terminal. Do not take keys in chat.

When they use a named profile, pass `--profile <name>` to every `s3-setup.mjs`
command. The identity needs permission to create buckets and IAM users.
AdministratorAccess or PowerUserAccess plus IAM is enough.

## 3. Choose a bucket

```sh
node integrations/agent-sessions/s3-setup.mjs buckets
```

Show the user the list and ask whether to use one of them or create a new one.
Suggest `suggestedBucket` from `check` for a new one. A dedicated bucket is
simplest. An existing bucket also works, because OpenCrawl only reads and writes
under `opencrawl/agent-sessions/`.

To create a new bucket, first confirm the name and region with the user, then run:

```sh
node integrations/agent-sessions/s3-setup.mjs create <bucket> --region <region>
```

It creates the bucket with public access blocked, SSE-S3 encryption, bucket-owner
object ownership and a policy that refuses non-TLS requests. If the name is taken
(`BucketAlreadyExists`), suggest another and ask again.

## 4. Connect the receiver to the bucket

Tell the user this creates (or updates) an IAM user named `opencrawl-receiver`,
with access to `opencrawl/agent-sessions/` in that bucket and nothing else, plus an
access key that is stored only in `integrations/agent-sessions/.env`. Then run:

```sh
node integrations/agent-sessions/s3-setup.mjs connect <bucket>
```

If it fails with `AccessDenied` on IAM, the user's organization may forbid IAM
users. Ask them for keys from their administrator, and have them put the keys in
`.env` themselves. When the receiver runs on AWS (EC2, ECS, EKS), leave the keys
empty and give the role the same permissions that `connect` grants (listed in the
README's Configuration section).

## 5. Start the receiver

```sh
integrations/agent-sessions/local.sh up
```

It checks the bucket before reporting success. Right after `connect`, new IAM keys
can take up to a minute to work. If `up` reports `InvalidAccessKeyId` or
`AccessDenied`, wait 30 seconds and run it again once.

## 6. Install the collector on this machine

```sh
curl -fsSL http://127.0.0.1:7171/install.sh | sh
node ~/.opencrawl/agent-sessions/collector.mjs status
```

Tell the user which agents were found and how many sessions there are. The first
sync is a full sync of every existing session. It takes a few minutes for a few
GB and runs in the background. After that, the collector syncs what changed every
hour. Ask whether they want a different schedule; to change it, rerun the install:
`curl -fsSL http://127.0.0.1:7171/install.sh | sh -s -- --every 15m`.

## 7. Optional

- **ChatGPT or Claude.ai history:** ask the user to request a data export
  (ChatGPT: Settings → Data controls → Export data. Claude: Settings → Privacy →
  Export data), unzip it, then run
  `node ~/.opencrawl/agent-sessions/collector.mjs import <folder>`.
- **Chat apps without local transcripts (Claude Desktop, Cursor):** add the MCP
  server as described in `integrations/agent-sessions/README.md#mcp`.
- **Keep a project out:** rerun the install with `--exclude <path fragment>`, for
  example `curl -fsSL http://127.0.0.1:7171/install.sh | sh -s -- --exclude client-acme`.

## Report back

Finish with: the bucket and region, the path sessions land under, the IAM user
created (if any), the agents found, the sync schedule, and how to stop
capture: `node ~/.opencrawl/agent-sessions/collector.mjs uninstall`.
