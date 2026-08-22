# hw-01 컨테이너 이미지 정리 정책

작성 2026-08-22. 대상 노드 **hw-01 (`hyunwoo-AM02`, k3s 단일 노드)**.
관련 파일: `infra/hw-01/` (스크립트·systemd 유닛·logrotate·설치 스크립트).

---

## 요약

- `math-teacher-api` 이미지를 **pull 시각 역순으로 최근 10개만 남기고** 지운다.
- **주 1회 systemd timer**(일요일 04:30 KST)로 돈다. k8s CronJob 이 아니다.
- **kubelet 기본 이미지 GC 는 그대로 둔다.** 임계값을 일부러 건드리지 않았다 (아래 참조).
- 기본 동작은 dry-run 이다. 실제 삭제는 `--apply` 를 줘야 한다.

---

## 왜 지금 만들었나

문제가 터져서가 아니라 **증가 속도가 곧 2.5배가 되기 때문**이다.

| 항목 | 실측 (2026-08-22) |
| --- | --- |
| 디스크 | `/dev/nvme0n1p2` 468G 중 43G 사용 (**10%**), 402G 여유 |
| containerd 디렉터리 | 25G (content store 5.8G + overlayfs 스냅샷 19G) |
| 이미지 | 전체 53개, 그중 `math-teacher-api` **34개** |
| 실행 중 | 1개 (`sha-45e9f31`, `math-teacher/api`) |
| 이미지 1개 크기 | 약 195~217MB (content store 기준) |

`math-teacher-api` 34개는 2026-08-07 ~ 08-22 사이 15일간 쌓인 것이다.
OCR 의존성이 들어가면 이미지가 약 510MB 로 커진다 → **하루 쌓이는 양이 2.5배**.
지금은 여유가 크지만, 커지고 나서 대응하면 이미 몇십 GB 를 낭비한 뒤다.

---

## kubelet 기본 GC 는 이미 돌고 있다 — 그래서 임계값은 안 건드렸다

이 조사는 반복하지 않아도 된다. **2026-08-22 실측**이다.

```
k3s 실행 인자 : server --tls-san 192.168.123.101 --write-kubeconfig-mode 644
/etc/rancher/k3s/config.yaml : 없음
```

즉 kubelet 이미지 GC 는 **기본값 그대로**다.

| 설정 | 기본값 | 지금 상태 |
| --- | --- | --- |
| `image-gc-high-threshold` | 85% | 디스크 10% → **조건 미달** |
| `image-gc-low-threshold` | 80% | — |
| `minimum-image-ttl-duration` | 2m | — |

**34개가 쌓인 것은 고장이 아니다.** 디스크가 85% 에 닿지 않아 GC 가 돌 이유가 없었던 것이다.

임계값을 낮추려면 k3s 인자를 고쳐 **k3s 를 재시작**해야 한다. 그러면:

- 서비스 중단이 생긴다 (단일 노드라 대체 노드가 없다).
- 디스크가 10% 인 상황에서 얻는 실익이 없다.
- kubelet GC 는 **오래된 것부터 무차별로** 지우므로 롤백용 이미지도 함께 날아간다.

그래서 **임계값은 그대로 두고, 임계값에 닿기 전에 미리 줄이는 스크립트를 따로 뒀다.**
이 스크립트는 kubelet GC 를 대체하지 않는다. 스크립트가 죽어도 85% 에서 kubelet 이 받아준다
— 안전망이 두 겹이다.

---

## 왜 10개를 남기나

**10은 사용자가 직접 정한 값이다(2026-08-22).**
> "오래된것보단 10개까지만 보관해도 롤백에는 문제가 없을것으로 보여져"

근거는 **하루 5개 배포 기준 이틀치 롤백 여유**다. 이전 태그 이미지가 노드에 있으면
ArgoCD 로 되돌릴 때 **pull 없이 즉시** 뜬다.

그보다 옛 버전이 필요해져도 **막히지 않는다.** GHCR 에 `sha-<gitsha>` 태그가 그대로 남아 있어
그 태그로 되돌리면 kubelet 이 다시 pull 한다. 즉 이 값이 좌우하는 것은 **롤백 속도**이지
롤백 가능성이 아니다.

값을 바꿀 자리는 스크립트의 `KEEP_COUNT` **한 곳**이다.

```bash
KEEP_COUNT=10
```

일시적으로 다르게 돌려 볼 때만 `--keep=N` 또는 `PRUNE_KEEP` 환경변수를 쓴다.

### 참고 — 실측 배포 빈도

pull 시각으로 실측한 배포 분포다. 평균은 하루 2.3개지만 **몰리는 날은 10개**였다.

| 날짜 | 배포 수 |
| --- | --- |
| 2026-08-07 | 4 |
| 2026-08-08 | 9 |
| 2026-08-09 | 2 |
| 2026-08-10 | 1 |
| 2026-08-14 | 4 |
| 2026-08-15 | 2 |
| **2026-08-21** | **10** |
| 2026-08-22 | 2 |

즉 2026-08-21 처럼 몰린 날 다음 아침에는 보관분 10개가 **그날 하루치로 다 차서**
전날 이미지로는 즉시 롤백이 안 될 수 있다. 그때는 GHCR pull 로 되돌린다(위 참조).
이 트레이드오프를 알고 10으로 정한 것이다.

비용: OCR 이후 510MB 기준 10개 = 약 5.1GB. 402GB 여유에 비해 무시할 수준이다
(현재 크기 기준 약 2.1GB).

### 개수와 "실행 중" 은 별개다

보존 집합은 **합집합**이다.

```
보존 = (최근 KEEP_COUNT개)  ∪  (컨테이너/파드/샌드박스가 참조하는 이미지)
삭제 = 후보 − 보존
```

**실행 중인 이미지가 11번째로 오래된 것이어도 지워지지 않는다.** 순서를 헷갈리면
돌고 있는 파드의 이미지를 지운다. 아래 "안전 장치 3" 에 `--keep=0` 으로 이 성질을
따로 검증한 결과가 있다.

---

## 왜 systemd timer 인가 (k8s CronJob 이 아니라)

| | systemd timer (선택) | k8s CronJob |
| --- | --- | --- |
| 필요 권한 | 노드 root (이미 그 권한으로 하는 일) | **특권 파드 + containerd 소켓 hostPath 마운트** |
| 클러스터가 죽었을 때 | 돈다 | 안 돈다 |
| 관리 위치 | 노드 파일 (레포에 원본) | 매니페스트 (GitOps) |
| 사고 반경 | 노드 스크립트 하나 | 클러스터 안에 containerd 를 조작할 수 있는 파드가 상주 |

**이 일은 노드 관리다.** 컨테이너 런타임을 정리하기 위해 컨테이너 런타임에 특권 접근하는
파드를 상주시키는 것은 목적에 비해 보안 표면이 지나치게 넓다. CronJob 은 GitOps 로 관리된다는
이점이 있지만, 그 이점은 **스크립트 원본을 레포에 두고 설치를 명령으로 남기는 것**으로 대체할 수 있다.
그래서 `infra/hw-01/` 에 전부 커밋해 둔다 — 노드에만 있으면 다음 사람이 못 찾는다.

---

## 안전 장치 — 무엇을 절대 지우지 않는가

세 겹이고, 셋 다 실제로 노드에서 검증했다.

### 1. 레포 화이트리스트 (시스템 이미지 차단)

스크립트 안에 하드코딩된 배열이다.

```bash
PRUNE_ALLOWED_REPOS=(
  "ghcr.io/hyunwoo-company/math-teacher-api"
)
```

`PRUNE_REPO` 가 이 목록에 없으면 **후보를 만들기도 전에 exit 78** 이다.
환경변수로 넓힐 수 없다. 대상을 늘리려면 코드를 고치고 커밋해야 한다.

이것이 "시스템 이미지를 지우면 클러스터가 깨진다" 를 **구조적으로** 막는다.
pause·coredns·traefik·metrics-server·argocd·fgg-server 는 후보 집합에 들어올 수 없다.

> 검증: `PRUNE_REPO=docker.io/rancher/mirrored-pause` 와
> `PRUNE_REPO=ghcr.io/hyunwoo-company/fgg-server` 로 `--keep=0` 을 줘도
> 둘 다 `FATAL ... 화이트리스트에 없다`, rc=78. 후보 목록조차 만들지 않는다.

### 2. 태그 전수 일치 (태그 섞인 이미지 차단)

후보는 **repoTags 가 하나 이상 있고, 그 전부가 `<repo>:` 로 시작하는** 이미지뿐이다.

```
select(((.repoTags // []) | length) > 0)
| select([.repoTags[] | startswith($repo + ":")] | all)
```

`crictl rmi <id>` 는 **그 id 에 붙은 태그를 전부** 지운다. 그래서 `any` 가 아니라 `all` 이어야 한다.
이 노드에 실제로 그런 예가 있다 — `fgg-server:latest` 와 `fgg-server:sha-d9422c1` 이 같은
이미지 id(`4098a16b09450`)를 공유한다. 태그가 섞인 이미지를 id 로 지우면 남길 태그까지 사라진다.
태그가 없는 이미지(`<none>`)도 이 조건에서 자동 제외된다.

> 검증: 노드 전체 53개 중 후보로 뽑힌 것이 정확히 34개 = `math-teacher-api` 개수.
> 나머지 19개는 후보 목록에 들어오지 않는다.

### 3. 사용 중 판정 (실행 중 이미지 차단)

`crictl` 의 사용 중 판정에 기대지 않고, **참조하는 문자열을 직접 모아 명시적으로 제외**한다.
모으는 곳이 네 군데다.

1. `crictl ps -a -o json` 의 `imageRef` / `imageId` / `image.image`
   — **`-a` 다.** Running 뿐 아니라 Exited 컨테이너까지. Exited 컨테이너도 kubelet 이
   재시작할 수 있고 이미지 참조가 살아 있다.
2. `kubectl get pods -A` 의 `spec.containers[].image`, `spec.initContainers[].image`,
   `status.containerStatuses[].imageID`
   — 아직 컨테이너가 만들어지지 않은 "원하는 이미지" 를 덮는다.
   클러스터가 응답하지 않으면 **`WARN` 을 로그에 남기고** 1번만으로 판단한다(조용히 넘기지 않는다).
3. containerd 설정의 `sandbox` 이미지.
   **파드 샌드박스는 컨테이너가 아니라서 `crictl ps -a` 에 나오지 않는다.**
   이 노드의 pause 는 `pinned=false` 라서 pinned 플래그에도 기댈 수 없다.
   설정값은 `rancher/mirrored-pause:3.6` 처럼 호스트가 없을 수 있어 `docker.io/` 접두 변형도 함께 넣는다.
4. **생성 시각을 알 수 없는 이미지** — config blob 이 없어 나이를 못 재면 보호하고 로그를 남긴다.
   모르는 것은 지우지 않는다.

판정은 이미지의 **id / 모든 repoTags / 모든 repoDigests** 중 하나라도 이 집합에 정확히 일치하면
보호다(`grep -Fxq`, 부분 문자열 매칭이 아니다).

> 검증: `--keep=0` 으로 "최근 N개 보호" 를 완전히 끄고 돌렸을 때
> `SKIP 사용 중(컨테이너/파드/샌드박스가 참조) ... sha-45e9f31` 이 나오고
> `skip=1 would_delete=33` 이었다. 즉 **실행 중 이미지의 보호는 keep 규칙과 독립**이다.
> keep=10 으로는 이 이미지가 KEEP[1] 이기도 하니 보호가 두 겹이다.

### 4. 최소 나이

최근 10개 밖이어도 **6시간 미만이면 지우지 않는다**(`PRUNE_MIN_AGE_HOURS`).
롤백 직후처럼 순서가 뒤엉킨 상황에서의 경합을 막는 여유다.

---

## 생성 시각을 어떻게 아는가 (비자명 — 다시 조사하지 말 것)

**CRI 에도 `ctr` 에도 이미지 생성 시각 필드가 없다.**

- `crictl images -o json` 의 이미지 객체: `id / repoTags / repoDigests / size / uid / username / spec / pinned`
  — 타임스탬프 없음.
- `k3s ctr -n k8s.io images ls` 의 컬럼: `REF / TYPE / DIGEST / SIZE / PLATFORMS / LABELS`
  — 타임스탬프 없음. `--help` 에도 `-q` 뿐이라 포맷 옵션이 없다 (containerd v2.2.2).
- 태그가 `sha-<gitsha>` 라서 이름만으로는 순서를 알 수 없다.

그래서 **containerd content store 의 image config blob mtime** 을 pull 시각으로 쓴다.

```
/var/lib/rancher/k3s/agent/containerd/io.containerd.content.v1.content/blobs/sha256/<config-digest>
```

`<config-digest>` 는 `crictl` 의 IMAGE ID 와 같다(= 이미지 config 다이제스트).

이 방법이 맞는지 실측으로 확인했다 — 34개의 mtime 이 **git 커밋 순서와 완전히 단조 일치**했고,
가장 최신(`sha-45e9f31`, 2026-08-22 13:09)이 실제로 실행 중인 이미지였다.

블랍이 없으면 나이를 모르는 것이므로 **보호**한다.

---

## 회수량

dry-run 이 찍는 "이미지 크기 합" 은 **상한**이다. 공유 레이어를 이미지마다 중복 계산한다.

2026-08-22 기준 실측/추정:

`KEEP_COUNT=10` 기준(삭제 대상 24개):

| | 값 | 근거 |
| --- | --- | --- |
| 이미지 크기 합(상한) | 4,870MB | `crictl` size 24개 합 |
| content store 실제 회수 | **3,823MB** | 삭제 대상의 압축 레이어 127개 중 **배타적 123개**의 바이트 합 (매니페스트 직접 계산) |
| overlayfs 스냅샷 회수 | *추정* 약 12~13GB | 같은 123개 레이어의 추출본. 이 노드의 압축→추출 비율 19G/5.8G ≈ 3.3배 적용 |
| 합계 | *추정* 약 16GB | 25GB 중 약 65% |

overlayfs 쪽을 **정확히는 못 쟀다.** `ctr snapshots usage` 의 KEY 가 chainID 가 아니라
스냅샷 내부 id 라서 레이어 → 스냅샷 매핑이 읽기 전용으로는 안 된다(chainID 를 계산해 맞춰
봤지만 353개 중 0개 매칭).

그래서 스크립트가 `--apply` 일 때 **`du -sb` 를 전/후로 재서 실제 줄어든 바이트를 로그에 남긴다.**
추정이 아니라 그 숫자가 진실이다.

---

## 설치

레포 파일이 원본이다. 노드 파일은 사본이다.

```bash
# 1) 레포 → 노드
scp -r infra/hw-01 hw-01:/tmp/hw-01-infra

# 2) 설치 (파일만 놓는다. 타이머는 켜지 않는다)
ssh hw-01 'sudo bash /tmp/hw-01-infra/install.sh'

# 3) 무엇을 지울지 눈으로 확인 — 아무것도 지우지 않는다
ssh hw-01 'sudo /usr/local/sbin/k3s-image-prune --dry-run'

# 4) 유닛 문법 확인
ssh hw-01 'systemd-analyze verify /etc/systemd/system/k3s-image-prune.service /etc/systemd/system/k3s-image-prune.timer'

# 5) 목록이 납득되면 한 번만 실제 실행
ssh hw-01 'sudo /usr/local/sbin/k3s-image-prune --apply'
ssh hw-01 'sudo tail -40 /var/log/k3s-image-prune.log'

# 6) 주 1회 자동 실행 켜기
ssh hw-01 'sudo systemctl enable --now k3s-image-prune.timer'
ssh hw-01 'systemctl list-timers k3s-image-prune.timer'
```

설치되는 위치:

| 레포 | 노드 |
| --- | --- |
| `infra/hw-01/k3s-image-prune.sh` | `/usr/local/sbin/k3s-image-prune` (0755) |
| `infra/hw-01/k3s-image-prune.service` | `/etc/systemd/system/k3s-image-prune.service` |
| `infra/hw-01/k3s-image-prune.timer` | `/etc/systemd/system/k3s-image-prune.timer` |
| `infra/hw-01/logrotate-k3s-image-prune` | `/etc/logrotate.d/k3s-image-prune` |

**k3s 를 재시작하지 않는다.** 설치는 `systemctl daemon-reload` 만 한다.

---

## 로그 — "왜 그 이미지가 없지?" 를 추적하는 방법

두 곳에 남는다.

```bash
# 파일 (월 단위 rotate, 12개 보관 = 1년치)
sudo grep DELETED /var/log/k3s-image-prune.log
sudo grep sha-3736b4a /var/log/k3s-image-prune.log   # 특정 태그가 언제 왜 사라졌나

# journal (systemd 실행분)
journalctl -u k3s-image-prune.service --since '-30d'
```

로그에는 회차마다 **KEEP 12줄 + SKIP 사유 + DELETED/WOULD-DELETE(태그·id·크기·pull 시각) + 요약**이
남는다. 실패는 `ERROR`(개별 이미지, 계속 진행) / `FATAL`(중단) / `WARN`(파드 정보 수집 실패) 으로
구분해 남기고, 실패가 있으면 exit 75 로 나가서 `systemctl status` 에 실패로 잡힌다.
**조용히 죽지 않는다.**

---

## 되돌리는 방법

### 정리를 멈추기만

```bash
ssh hw-01 'sudo systemctl disable --now k3s-image-prune.timer'
```

이것만으로 자동 실행이 끝난다. 스크립트는 남아 있으니 필요할 때 수동으로 부를 수 있다.

### 완전히 제거

```bash
ssh hw-01 'sudo systemctl disable --now k3s-image-prune.timer
           sudo rm -f /etc/systemd/system/k3s-image-prune.timer \
                      /etc/systemd/system/k3s-image-prune.service \
                      /etc/logrotate.d/k3s-image-prune \
                      /usr/local/sbin/k3s-image-prune
           sudo systemctl daemon-reload'
```

로그(`/var/log/k3s-image-prune.log*`)는 남긴다 — 기록이 사라지면 추적이 안 된다.

### 지워진 이미지가 다시 필요해졌을 때

**되돌릴 수 없다. 하지만 잃은 것도 없다.** GHCR 이 진실의 출처이고 태그는 그대로 남아 있다.
그 태그로 ArgoCD/Deployment 를 되돌리면 kubelet 이 다시 pull 한다.
노드에 이미지가 있었으면 즉시, 없으면 pull 시간(약 200MB, OCR 후 약 510MB)만큼 더 걸리는 차이뿐이다.

이 스크립트가 바꾸는 것은 **롤백 속도**이지 롤백 가능성이 아니다.

---

## 남은 것 / 안 한 것

- **실제 삭제를 하지 않았다.** 2026-08-22 시점에는 dry-run 까지만 확인했고
  노드에 파일도 설치하지 않았다(스크립트를 stdin 으로 흘려 실행). 설치·실행은 위 절차대로.
- **kubelet GC 임계값은 손대지 않았다.** 의도적이다(위 참조).
- **overlayfs 회수량을 정확히 재지 못했다.** 첫 `--apply` 로그의 `실제 회수` 값으로 확정된다.
- **`math-teacher-api` 에 `latest` 같은 이동 태그가 붙으면** 그 태그가 오래된 이미지에
  남아 있을 때 지워질 수 있다. 지금 이 레포의 CI 는 `sha-<gitsha>` 불변 태그만 쓰므로 해당 없다.
  이동 태그를 쓰게 되면 보호 목록에 태그 이름을 추가해야 한다.
- **fgg-server / lexio-server 이미지는 이 정책의 대상이 아니다.** 화이트리스트에 없다.
  필요하면 별도 판단으로 추가할 일이다.

  브리프의 "전체 54개 중 20개는 k3s 시스템 이미지" 와 실측이 다르다. 2026-08-22 실측 내역:

  | 분류 | 고유 이미지 수 |
  | --- | --- |
  | `math-teacher-api` (정리 대상) | 34 |
  | 플랫폼/시스템 (pause·coredns·traefik·metrics-server·klipper×2·local-path·dashboard×2·argocd·redis·dex·cloudflared) | 13 |
  | `fgg-server` (태그 6개, 고유 이미지 5개 — `latest` 와 `sha-d9422c1` 이 같은 id) | 5 |
  | `lexio-server:latest` | 1 |
  | **합계** | **53** |

  전체가 54가 아니라 **53**이고, 정리 대상이 아닌 것은 20개가 아니라 **19개**다.
  결론은 바뀌지 않는다 — 어느 쪽이든 화이트리스트가 34개 외의 전부를 차단한다.
