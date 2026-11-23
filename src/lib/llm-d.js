// Based on llm-d's no-Kubernetes deployment and PD disaggregation guides.
export function llmDRouterCommands(config, prefillPort, decodePort) {
  const sidecarPort = [8200, 8201, 8202].find((port) => port !== prefillPort && port !== decodePort);
  const decodeSidecar = {
    label: "Decode sidecar",
    description: "Run on the decode head after vLLM starts. The sidecar forwards requests to the local decode server.",
    command: `docker run -d --name llm-d-decode --network host \\\n  ${config.sidecar_image} \\\n  --port=${sidecarPort} --model-server-port=${decodePort} --kv-connector=nixlv2 --secure-serving=false`,
  };
  const router = {
    label: "llm-d Router",
    description: "Run on the router host after both pools and the decode sidecar are ready. Use literal IPv4 addresses for the serving heads. Keep worker and sidecar ports on a trusted network.",
    port: 30000,
    command: `(
set -eu
config_dir=$(mktemp -d)
# The images run as non-root; allow them to read the generated configs.
chmod 755 "$config_dir"

cat > "$config_dir/endpoints.yaml" <<EOF
endpoints:
  - name: prefill
    address: "$PREFILL_NODE_1"
    port: "${prefillPort}"
    labels: {llm-d.ai/role: prefill}
  - name: decode
    address: "$DECODE_NODE_1"
    port: "${sidecarPort}"
    labels: {llm-d.ai/role: decode}
EOF

cat > "$config_dir/epp.yaml" <<'EOF'
apiVersion: llm-d.ai/v1
kind: EndpointPickerConfig
plugins:
  - type: file-discovery
    parameters: {path: /etc/epp/endpoints.yaml}
  - type: always-disagg-pd-decider
  - type: disagg-profile-handler
    parameters:
      deciders: {prefill: always-disagg-pd-decider}
  - type: prefill-filter
  - type: decode-filter
  - type: max-score-picker
  - type: metrics-data-source
  - type: core-metrics-extractor
schedulingProfiles:
  - name: prefill
    plugins:
      - pluginRef: prefill-filter
      - pluginRef: max-score-picker
  - name: decode
    plugins:
      - pluginRef: decode-filter
      - pluginRef: max-score-picker
dataLayer:
  injectDefaults: false
  discovery:
    endpoints: {pluginRef: file-discovery}
  sources:
    - pluginRef: metrics-data-source
      extractors:
        - pluginRef: core-metrics-extractor
EOF

cat > "$config_dir/envoy.yaml" <<EOF
static_resources:
  listeners:
    - name: inference
      address:
        socket_address: {address: 0.0.0.0, port_value: $ROUTER_PORT}
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: inference
                early_header_mutation_extensions:
                  - name: envoy.http.early_header_mutation.header_mutation
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.http.early_header_mutation.header_mutation.v3.HeaderMutation
                      mutations:
                        - remove: x-gateway-destination-endpoint
                route_config:
                  name: inference
                  virtual_hosts:
                    - name: inference
                      domains: ["*"]
                      routes:
                        - match: {prefix: "/"}
                          route: {cluster: workers, timeout: 0s}
                http_filters:
                  - name: envoy.filters.http.ext_proc
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExternalProcessor
                      grpc_service:
                        envoy_grpc: {cluster_name: epp}
                      processing_mode:
                        request_header_mode: SEND
                        response_header_mode: SEND
                        request_body_mode: FULL_DUPLEX_STREAMED
                        response_body_mode: FULL_DUPLEX_STREAMED
                        request_trailer_mode: SEND
                        response_trailer_mode: SEND
                      message_timeout: 1000s
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: workers
      type: ORIGINAL_DST
      connect_timeout: 5s
      lb_policy: CLUSTER_PROVIDED
      original_dst_lb_config: {use_http_header: true, http_header_name: x-gateway-destination-endpoint}
    - name: epp
      type: STATIC
      connect_timeout: 5s
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: {http2_protocol_options: {}}
      load_assignment:
        cluster_name: epp
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: {address: 127.0.0.1, port_value: 9002}
EOF
chmod 644 "$config_dir/"*.yaml

docker run -d --name llm-d-epp --network host \\\n  -v "$config_dir:/etc/epp:ro" ${config.epp_image} \\\n  --config-file=/etc/epp/epp.yaml --pool-name=file-discovery --pool-namespace=default \\\n  --grpc-port=9002 --grpc-health-port=9003 --secure-serving=false --health-checking=true --tracing=false --enable-pprof=false
docker run -d --name llm-d-envoy --network host \\\n  -v "$config_dir/envoy.yaml:/etc/envoy/envoy.yaml:ro" ${config.envoy_image} \\\n  --log-level warn -c /etc/envoy/envoy.yaml
)`,
  };
  return { decodeSidecar, router };
}
