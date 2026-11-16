{{/*
The pinned upstream chart has no primary JDBC URL value. A parent template
override sets its ConfigMap value for all consumers, including pre-install hooks.
Using env_vars would duplicate DATABASE_URL and break Kubernetes upgrade patches.
*/}}
{{- define "airbyte.database.url" -}}
{{- required "global.database.jdbcUrl is required" .Values.global.database.jdbcUrl -}}
{{- end -}}

{{/* Keep certificate hostname verification enabled for both Temporal DB paths. */}}
{{- define "airbyte.temporal.database.tlsDisableHostVerification" -}}false{{- end -}}
{{- define "airbyte.temporal.database.sqlTlsDisableHostVerification" -}}false{{- end -}}
