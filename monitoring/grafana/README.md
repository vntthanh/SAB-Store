# SAB-Store dashboards on the shared Grafana

`https://monitor.noboroto.id.vn`, folder **Infrastructure**: `sab-store-infra` (uptime, container CPU/RAM vs limit, restarts/OOM) and `sab-store-app` (traffic, errors, latency, orders, stock ledger, nginx) built from the JSON logs described in `docs/deployment.md` ("Logs").

The Grafana is shared by several projects, so nothing here is provisioned: edit in the UI, then Export with "Export for sharing externally" OFF and overwrite the JSON in this folder. Never hand-edit the JSON.

## Alert rules

Contact point Discord; labels `project=sab-store`, `host=david-host`, `severity`.

| Rule | Group | Datasource | Query (A) | Fires when | For | Severity | Exec error | No data |
|---|---|---|---|---|---|---|---|---|
| SAB-Store — site không truy cập được (probe từ david-host) | Uptime | `ee4bzyaammnswc` | `min by (instance) (probe_success{job="blackbox-http",project="sab-store"})` | A < 1 | 2m | critical | Error | NoData |
| SAB-Store — RAM backend > 90% giới hạn (10 phút) | SAB-Store | `ee4bzyaammnswc` | `max(container_memory_working_set_bytes{name=~"sabstore-backend-xy4efknzf2uepknbnsktconc.*"} / (container_spec_memory_limit_bytes{name=~"sabstore-backend-xy4efknzf2uepknbnsktconc.*"} > 0))` | A > 0.9 | 10m | warning | KeepLast | OK |
| SAB-Store — container bị OOM kill | SAB-Store | `ee4bzyaammnswc` | `sum by (name) (increase(container_oom_events_total{name=~".*xy4efknzf2uepknbnsktconc.*"}[15m]))` | A > 0 | 0s | critical | KeepLast | OK |
| SAB-Store — container khởi động lại > 2 lần / 15 phút | SAB-Store | `ee4bzyaammnswc` | `max by (name) (changes(container_start_time_seconds{name=~".*xy4efknzf2uepknbnsktconc.*"}[15m]))` | A > 2 | 0s | critical | KeepLast | OK |
| SAB-Store — p95 API > 2s (10 phút) | SAB-Store | `david-loki` | `max(quantile_over_time(0.95, {project="sab-store",service="backend",type="access"} \| json \| status!="499" \| unwrap ms \| __error__="" [10m]))` | A > 2000 | 10m | warning | KeepLast | OK |
| SAB-Store — stock movement pending kẹt > 15 phút | SAB-Store | `david-loki` | `max(max_over_time({project="sab-store",service="backend",event="stock.sweeper"} \| json \| unwrap oldestPendingSec \| __error__="" [10m]))` | A > 900 | 5m | warning | KeepLast | OK |
| SAB-Store — stock movement thất bại | SAB-Store | `david-loki` | `sum(count_over_time({project="sab-store",service="backend",event="stock.movement.failed"}[15m])) or vector(0)` | A > 0 | 0s | critical | KeepLast | OK |
| SAB-Store — tỉ lệ 5xx API > 5% (5 phút) | SAB-Store | `david-loki` | `(sum(count_over_time({project="sab-store",service="backend",type="access"} \| json \| status=~"5.." [5m])) or vector(0)) / sum(count_over_time({project="sab-store",service="backend",type="access"} [5m]))` | A > 0.05 | 5m | critical | KeepLast | OK |

## Notes

- `ms` in the backend access log is milliseconds, so the p95 threshold is 2000.
- Loki queries narrow on the `type` / `event` stream label before `| json` and `unwrap`.
- Summaries that read `$values.A.Value` are wrapped in `{{ if $values.A }}`: a query can return no value when there is no traffic.
- Rules reading cadvisor or Loki keep their last state on a query error (`KeepLast`), so a monitoring-stack redeploy does not page. The uptime rule keeps `Error`.
- Traffic panels exclude the uptime probe: backend `ip!="10.0.1.1"` (internal gateway when david-host calls its own domain), frontend `ua!~"Blackbox.*"`.
