#!/usr/bin/env bash
#
# hw-01 노드에 이미지 정리 스크립트/타이머를 설치한다.
#
#   레포에서:  scp -r infra/hw-01 hw-01:/tmp/hw-01-infra
#   노드에서:  sudo bash /tmp/hw-01-infra/install.sh
#
# 이 스크립트는 파일만 놓고 타이머를 **켜지 않는다.**
# 첫 dry-run 을 사람이 눈으로 확인한 뒤 마지막 단계를 직접 실행해야 한다.
#
set -Eeuo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해야 한다" >&2; exit 1; }

install -m 0755 -o root -g root "$SRC/k3s-image-prune.sh" /usr/local/sbin/k3s-image-prune
install -m 0644 -o root -g root "$SRC/k3s-image-prune.service" /etc/systemd/system/k3s-image-prune.service
install -m 0644 -o root -g root "$SRC/k3s-image-prune.timer"   /etc/systemd/system/k3s-image-prune.timer
install -m 0644 -o root -g root "$SRC/logrotate-k3s-image-prune" /etc/logrotate.d/k3s-image-prune

systemctl daemon-reload

cat <<'MSG'

설치 완료. 타이머는 아직 꺼져 있다.

다음 순서로 확인하고 켜라.

  1) 무엇을 지울지 눈으로 확인 (아무것도 지우지 않는다)
       sudo /usr/local/sbin/k3s-image-prune --dry-run

  2) 유닛 파일 문법 확인
       systemd-analyze verify /etc/systemd/system/k3s-image-prune.service
       systemd-analyze verify /etc/systemd/system/k3s-image-prune.timer

  3) 목록이 납득되면 한 번만 실제로 실행
       sudo /usr/local/sbin/k3s-image-prune --apply
       sudo tail -40 /var/log/k3s-image-prune.log

  4) 주 1회 자동 실행 켜기
       sudo systemctl enable --now k3s-image-prune.timer
       systemctl list-timers k3s-image-prune.timer

MSG
