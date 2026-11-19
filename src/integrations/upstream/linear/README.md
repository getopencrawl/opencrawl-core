# Airbyte source-linear

`manifest.json` is a lossless YAML-to-JSON conversion of Airbyte's unmodified
source-linear manifest. `provenance.json` pins its repository revision, version,
source path and YAML SHA-256. This vendored manifest is under the Elastic License
2.0 in `LICENSE`; OpenCrawl's original code remains Apache-2.0.

The runtime adapter in `../../linear-upstream.mts` changes transport and
credential setup, selects our tested declarative runtime, and shortens the
definition description for Airbyte's storage. Airbyte retains extraction, all 20 streams, GraphQL queries,
schemas, transformations, pagination, rate handling and incremental cursors.
`../../linear-access.mts` is OpenCrawl's resource permission adapter, not another
source implementation. Collection and indexing check visibility against the connected Linear organization.
Indexing also reconciles existing records. Authenticated retrieval uses the workspace index.

To update, fetch the manifest and license from an immutable upstream revision,
convert YAML to JSON without changing values, update provenance and version,
review stream/query changes, and run the real declarative-runtime tests plus a
real workspace sync. Do not silently edit the vendored manifest.
