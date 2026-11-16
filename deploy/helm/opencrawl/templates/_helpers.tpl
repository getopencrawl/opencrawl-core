{{- define "opencrawl.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- define "opencrawl.labels" -}}
app.kubernetes.io/name: opencrawl
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
{{- define "opencrawl.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ required "image.tag or image.digest must select a published immutable runtime" .Values.image.tag }}
{{- end -}}
{{- end -}}
{{- define "opencrawl.scheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
{{- define "opencrawl.storage" -}}
accessModes: [ReadWriteOnce]
{{- if .root.Values.storageClass }}
storageClassName: {{ .root.Values.storageClass | quote }}
{{- end }}
resources:
  requests:
    storage: {{ .size }}
{{- end -}}
{{- define "opencrawl.runtimeEnv" -}}
envFrom:
  - configMapRef:
      name: {{ include "opencrawl.name" . }}-runtime
  - secretRef:
      name: {{ required "runtime.existingSecret is required" .Values.runtime.existingSecret }}
{{- with .Values.runtime.extraEnv }}
env: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
{{- define "opencrawl.runtimeMounts" -}}
volumeMounts:
  - {name: tmp, mountPath: /tmp}
{{- with .Values.runtime.extraVolumeMounts }}
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}
{{- define "opencrawl.runtimeVolumes" -}}
volumes:
  - name: tmp
    emptyDir: {}
{{- with .Values.runtime.extraVolumes }}
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}
