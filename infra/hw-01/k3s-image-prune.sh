#!/usr/bin/env bash
#
# k3s-image-prune — hw-01(k3s 단일 노드) containerd 에 쌓인
#                   math-teacher-api 이미지를 최근 N개만 남기고 정리한다.
#
# 설계 원칙
#   1. 기본 동작은 DRY-RUN 이다. 실제 삭제는 --apply 를 줘야만 한다.
#   2. 대상 레포는 화이트리스트(PRUNE_ALLOWED_REPOS)에 있는 것만이다.
#      PRUNE_REPO 를 잘못 넘기면 후보를 만들기도 전에 종료한다.
#      → k3s 시스템 이미지(pause/coredns/traefik/metrics-server/argocd ...)는
#        구조적으로 후보가 될 수 없다.
#   3. 지울 수 있는 것은 "태그가 전부 $PRUNE_REPO: 로 시작하는 이미지" 뿐이다.
#      태그 없는 이미지, 다른 레포 태그가 섞인 이미지는 건드리지 않는다.
#      (crictl rmi <id> 는 그 id 에 붙은 태그를 전부 지우므로 이 조건이 안전의 핵심)
#   4. 보호: 컨테이너(Running + Exited 전부)가 참조하는 이미지 / 파드 spec·status 의
#      이미지 / containerd 샌드박스 이미지 / 생성 시각을 알 수 없는 이미지.
#   5. 최근 $KEEP_COUNT(기본 10)개는 롤백용으로 남긴다.
#   6. 실패해도 조용히 죽지 않는다. 모든 판단과 결과를 로그에 남긴다.
#
# kubelet 기본 이미지 GC(high 85% / low 80% / minimum-image-ttl 2m)는 그대로 둔다.
# 이 스크립트는 그것을 대체하지 않고, 임계값에 닿기 전에 미리 줄이는 역할만 한다.
# 배경·되돌리는 방법: docs/hw-01-image-prune.md
#
set -Eeuo pipefail

PRUNE_REPO="${PRUNE_REPO:-ghcr.io/hyunwoo-company/math-teacher-api}"

# ── 남길 개수 ──────────────────────────────────────────────────────────────
# 값을 바꿀 자리는 여기 한 곳이다.
#
# 10 = 사용자 결정(2026-08-22). 하루 5개 배포 기준 **이틀치 롤백 여유**다.
# 그보다 옛 버전이 필요해지면 GHCR 에 `sha-<gitsha>` 태그가 그대로 남아 있으므로
# pull 로 되돌릴 수 있다 — **즉시 롤백만 못 하고, 롤백 자체가 불가능해지는 것은 아니다.**
#
# 이 10개는 $PRUNE_REPO 이미지만 센다. 시스템 이미지는 애초에 후보가 아니다(화이트리스트).
# 그리고 실행 중 이미지는 이 개수와 **무관하게** 보존된다 —
# 보존 집합 = (최근 KEEP_COUNT개) ∪ (컨테이너/파드/샌드박스가 참조하는 것),
# 삭제 대상 = 그 여집합. 실행 중인 것이 11번째로 오래된 이미지여도 지워지지 않는다.
KEEP_COUNT=10
# 실험/조사용 일시 override. 평상시엔 쓰지 않는다.
KEEP_COUNT="${PRUNE_KEEP:-$KEEP_COUNT}"
# 최근 N개 밖이어도 이보다 어리면 지우지 않는다(배포 직후 경합 대비).
PRUNE_MIN_AGE_HOURS="${PRUNE_MIN_AGE_HOURS:-6}"
PRUNE_LOG="${PRUNE_LOG:-/var/log/k3s-image-prune.log}"
CONTAINERD_ROOT="${CONTAINERD_ROOT:-/var/lib/rancher/k3s/agent/containerd}"
CONTAINERD_CONFIG="${CONTAINERD_CONFIG:-/var/lib/rancher/k3s/agent/etc/containerd/config.toml}"
BLOB_DIR="$CONTAINERD_ROOT/io.containerd.content.v1.content/blobs/sha256"
export CONTAINER_RUNTIME_ENDPOINT="${CONTAINER_RUNTIME_ENDPOINT:-unix:///run/k3s/containerd/containerd.sock}"
export IMAGE_SERVICE_ENDPOINT="${IMAGE_SERVICE_ENDPOINT:-$CONTAINER_RUNTIME_ENDPOINT}"

# 대상을 늘리려면 여기에 명시적으로 추가해야 한다. 환경변수로는 못 넓힌다.
PRUNE_ALLOWED_REPOS=(
  "ghcr.io/hyunwoo-company/math-teacher-api"
)

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply)   APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --keep=*)  KEEP_COUNT="${arg#--keep=}" ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

MODE="DRY-RUN"
if [ "$APPLY" -eq 1 ]; then MODE="APPLY"; fi

log() {
  local line
  line="$(date --iso-8601=seconds) [$MODE] $*"
  printf '%s\n' "$line"
  { printf '%s\n' "$line" >>"$PRUNE_LOG"; } 2>/dev/null || true
}

fail_trap() {
  local rc=$? cmd=$BASH_COMMAND line=${BASH_LINENO[0]}
  log "FATAL rc=$rc line=$line cmd='$cmd' — 중단한다"
  exit "$rc"
}
trap fail_trap ERR

need() { command -v "$1" >/dev/null 2>&1 || { log "FATAL '$1' 이 없다"; exit 70; }; }
need crictl
need jq
need stat

allowed=0
for r in "${PRUNE_ALLOWED_REPOS[@]}"; do
  if [ "$PRUNE_REPO" = "$r" ]; then allowed=1; break; fi
done
if [ "$allowed" -ne 1 ]; then
  log "FATAL PRUNE_REPO=$PRUNE_REPO 는 화이트리스트에 없다 — 아무것도 하지 않는다"
  log "      허용: ${PRUNE_ALLOWED_REPOS[*]}"
  exit 78
fi

log "시작 repo=$PRUNE_REPO keep=$KEEP_COUNT min_age=${PRUNE_MIN_AGE_HOURS}h endpoint=$CONTAINER_RUNTIME_ENDPOINT"

# 실제 회수량은 공유 레이어 때문에 이미지 크기 합으로 알 수 없다.
# APPLY 일 때만 전/후 du 를 재서 진짜 줄어든 바이트를 로그에 남긴다.
du_before=0
if [ "$APPLY" -eq 1 ]; then
  du_before=$(du -sb "$CONTAINERD_ROOT" 2>/dev/null | cut -f1 || echo 0)
  log "containerd 사용량(작업 전) $((du_before / 1000000))MB"
fi

# ---------------------------------------------------------------- 보호 집합
protected_file="$(mktemp)"
candidates_file=""
dated_file=""
cleanup() { rm -f "$protected_file" "$candidates_file" "$dated_file" 2>/dev/null || true; }
trap cleanup EXIT

count_lines() { grep -c . "$1" 2>/dev/null || true; }

# 컨테이너가 참조하는 이미지: Running 뿐 아니라 Exited 까지.
# (Exited 컨테이너도 kubelet 이 재시작할 수 있고 이미지 참조가 살아 있다)
if ! crictl ps -a -o json 2>/dev/null \
     | jq -r '.containers[]? | (.imageRef // empty), (.imageId // empty), (.image.image // empty)' \
     >>"$protected_file"; then
  log "FATAL crictl ps 실패 — 사용 중 이미지를 확인할 수 없어 아무것도 지우지 않는다"
  exit 71
fi
log "보호(컨테이너 참조) $(count_lines "$protected_file") 개 수집"

# 파드 spec 의 원하는 이미지도 보호한다(아직 컨테이너가 안 만들어진 경우 대비).
# 클러스터가 죽어도 스크립트는 돌아야 하므로 실패는 경고로만 남긴다.
POD_JSONPATH='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{range .spec.initContainers[*]}{.image}{"\n"}{end}{range .status.containerStatuses[*]}{.imageID}{"\n"}{end}{end}'
if command -v k3s >/dev/null 2>&1 \
   && k3s kubectl get pods -A -o jsonpath="$POD_JSONPATH" >>"$protected_file" 2>/dev/null; then
  log "보호(파드 spec/status 이미지) 추가 수집 성공"
else
  log "WARN 파드 spec 이미지 수집 실패(클러스터 미응답?) — 컨테이너 참조만으로 판단한다"
fi

# 샌드박스(pause) 이미지는 crictl ps 에 안 잡힌다 — 샌드박스는 컨테이너가 아니다.
# containerd 설정값을 직접 읽어 넣는다. 설정에는 레지스트리 호스트가 없을 수 있어
# (rancher/mirrored-pause:3.6) crictl repoTags(docker.io/rancher/...)와 맞도록
# docker.io 접두 변형도 함께 넣는다.
if [ -r "$CONTAINERD_CONFIG" ]; then
  while read -r sb; do
    [ -n "$sb" ] || continue
    printf '%s\n' "$sb" >>"$protected_file"
    case "$sb" in
      */*/*) : ;;
      */*)   printf 'docker.io/%s\n' "$sb" >>"$protected_file" ;;
      *)     printf 'docker.io/library/%s\n' "$sb" >>"$protected_file" ;;
    esac
  done < <(grep -oE '^[[:space:]]*sandbox(_image)?[[:space:]]*=[[:space:]]*"[^"]+"' \
                 "$CONTAINERD_CONFIG" 2>/dev/null | cut -d'"' -f2 || true)
fi

sort -u -o "$protected_file" "$protected_file"
log "보호 집합 총 $(count_lines "$protected_file") 개 문자열(id/태그/다이제스트)"

is_protected() { # $1..$n: 이 이미지를 가리킬 수 있는 모든 문자열
  local ref
  for ref in "$@"; do
    [ -n "$ref" ] || continue
    if grep -Fxq -- "$ref" "$protected_file"; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- 후보 집합
# all(...) : 태그가 전부 $PRUNE_REPO: 로 시작하는 이미지만 후보가 된다.
#            태그 없는 이미지와 타 레포 태그가 섞인 이미지는 자동 제외.
candidates_file="$(mktemp)"
crictl images -o json \
  | jq -r --arg repo "$PRUNE_REPO" '
      .images[]
      | select(((.repoTags // []) | length) > 0)
      | select([.repoTags[] | startswith($repo + ":")] | all)
      | [ .id,
          ((.repoTags // []) | join(",")),
          ((.repoDigests // []) | join(",")),
          ((.size // "0") | tostring)
        ] | @tsv' \
  >"$candidates_file"

log "노드 전체 이미지 $(crictl images -q | wc -l) 개 / 후보 $(count_lines "$candidates_file") 개"

if ! grep -q . "$candidates_file"; then
  log "후보가 없다 — 종료"
  exit 0
fi

# 생성 시각: containerd content store 의 image config blob mtime = pull 시각.
# CRI ImageStatus 에도 ctr images ls 에도 생성 시각 필드가 없어 이 방법을 쓴다.
now=$(date +%s)
min_age_s=$(( PRUNE_MIN_AGE_HOURS * 3600 ))
dated_file="$(mktemp)"
undatable=0
while IFS=$'\t' read -r id tags digests size; do
  [ -n "$id" ] || continue
  if mtime=$(stat -c %Y "$BLOB_DIR/${id#sha256:}" 2>/dev/null); then
    printf '%s\t%s\t%s\t%s\t%s\n' "$mtime" "$id" "$tags" "$digests" "$size" >>"$dated_file"
  else
    undatable=$((undatable + 1))
    log "SKIP  보호: 생성 시각 불명(config blob 없음) $tags ($id)"
  fi
done <"$candidates_file"
if [ "$undatable" -gt 0 ]; then log "생성 시각 불명으로 보호한 이미지 $undatable 개"; fi

sort -rn -k1,1 -o "$dated_file" "$dated_file"

kept=0; doomed=0; skipped=0; failed=0; bytes=0
while IFS=$'\t' read -r mtime id tags digests size; do
  [ -n "$id" ] || continue
  when=$(date -d "@$mtime" --iso-8601=seconds)

  if [ "$kept" -lt "$KEEP_COUNT" ]; then
    kept=$((kept + 1))
    log "KEEP  [$kept/$KEEP_COUNT] $when  $tags"
    continue
  fi

  IFS=',' read -r -a tag_arr <<<"$tags"
  IFS=',' read -r -a dig_arr <<<"$digests"
  if is_protected "$id" "${tag_arr[@]}" "${dig_arr[@]}"; then
    skipped=$((skipped + 1))
    log "SKIP  사용 중(컨테이너/파드/샌드박스가 참조) $when  $tags"
    continue
  fi

  if [ $(( now - mtime )) -lt "$min_age_s" ]; then
    skipped=$((skipped + 1))
    log "SKIP  ${PRUNE_MIN_AGE_HOURS}h 미만으로 어리다 $when  $tags"
    continue
  fi

  if [ "$APPLY" -eq 1 ]; then
    if crictl rmi "$id" >/dev/null 2>&1; then
      doomed=$((doomed + 1)); bytes=$(( bytes + size ))
      log "DELETED $when  $tags  ($id, $((size / 1000000))MB)"
    else
      failed=$((failed + 1))
      log "ERROR  삭제 실패(계속 진행) $when  $tags ($id)"
    fi
  else
    doomed=$((doomed + 1)); bytes=$(( bytes + size ))
    log "WOULD-DELETE $when  $tags  ($id, $((size / 1000000))MB)"
  fi
done <"$dated_file"

verb="would_delete"
if [ "$APPLY" -eq 1 ]; then verb="deleted"; fi
log "요약 keep=$kept skip=$((skipped + undatable)) $verb=$doomed fail=$failed"
log "이미지 크기 합 $((bytes / 1000000))MB (공유 레이어를 중복 계산하므로 실제 회수량의 상한)"

if [ "$APPLY" -eq 1 ]; then
  du_after=$(du -sb "$CONTAINERD_ROOT" 2>/dev/null | cut -f1 || echo 0)
  log "containerd 사용량(작업 후) $((du_after / 1000000))MB / 실제 회수 $(( (du_before - du_after) / 1000000 ))MB"
  log "디스크 $(df -h --output=pcent,avail "$CONTAINERD_ROOT" 2>/dev/null | tail -1 | tr -s ' ')"
fi

if [ "$failed" -ne 0 ]; then
  log "삭제 실패 $failed 건 — 비정상 종료"
  exit 75
fi
log "정상 종료"
