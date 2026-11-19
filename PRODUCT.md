# OpenCrawl

## Platform

web

## Operating Context

Agents use the CLI and MCP to search workspace knowledge. People use the React
console to connect a machine or a source, find a captured conversation, and
manage their workspace. The same console runs in self-hosted and cloud deployments.
A person's role and the configured adapters determine which actions are available.

## Evidence on Hand

The [route registry](web-v2/src/application/app.tsx) shows the available screens.
For a console change, the [design guide](DESIGN.md#components) pairs real tasks
and states with existing screens and browser fixtures.
