# OpenCrawl GitHub source for Airbyte. Build this directory with Docker and make
# the image available to your Airbyte workers; see docs/self-host.md.
# The base is the declarative runtime we already pin, for its Python and airbyte-cdk.
FROM airbyte/source-declarative-manifest:7.45.1@sha256:f98cd95b4263c30c76b23c67b9c43e817e4f6b000663081e91778748b50d32e1
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY source.py /airbyte/integration_code/source.py
RUN chmod 0644 /airbyte/integration_code/source.py
ENV AIRBYTE_ENTRYPOINT="python /airbyte/integration_code/source.py" GIT_TERMINAL_PROMPT=0
ENTRYPOINT ["python", "/airbyte/integration_code/source.py"]
USER airbyte
