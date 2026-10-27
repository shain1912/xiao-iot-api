# XIAO ESP32-S3 IoT API

Seeed XIAO ESP32-S3의 터치 센서 값을 보고 LED를 제어하는 API 테스트용 프로젝트입니다.

```
[XIAO 보드] ──HTTPS POST /api/device/report (1초마다)──▶ [FastAPI · Render] ──▶ [Supabase Postgres]
                       ◀── {"led": true} ──────────────────┘        ▲
[웹 대시보드 · Vercel] ──HTTPS (로그인 토큰)─────────────────────────┘
```

보드는 밖으로 나가는 요청만 보냅니다. 그래서 보드와 브라우저가 서로 다른 네트워크에 있어도 제어할 수 있습니다.
LED 명령은 보드의 다음 보고(최대 약 1초 뒤)에 응답으로 전달됩니다.

| 폴더 | 내용 |
| --- | --- |
| `backend/` | FastAPI. 회원가입·로그인(bcrypt + JWT), 장치 상태, LED 제어, 센서 기록 |
| `frontend/` | 정적 웹 대시보드(HTML/JS). 로그인, 센서 값, LED 버튼, 10분 그래프, API 호출 로그 |

보드 펌웨어는 이 저장소에 없습니다(와이파이 비밀번호가 들어 있어서). 원본 프로젝트의 `CloudAPIDashboard/`를 쓰세요.

## API

자동 문서: `<API 주소>/docs` (Swagger UI)

| 메서드 | 경로 | 인증 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | - | `{email, password}` → `{token, user}`. 비밀번호 8~72자 |
| POST | `/api/auth/login` | - | `{email, password}` → `{token, user}` |
| GET | `/api/auth/me` | Bearer | 로그인한 사용자 |
| GET | `/api/device` | Bearer | `{led, touched, touch_value, threshold, rssi, updated_at, online}` |
| POST | `/api/device/led` | Bearer | `{state: "on" \| "off" \| "toggle"}` |
| GET | `/api/device/history?minutes=10` | Bearer | 센서 기록(5초 간격, 터치가 바뀌면 즉시). 24시간 보관 |
| POST | `/api/device/report` | `X-Device-Key` | 보드 전용. 센서 값을 보내면 `{led}`를 돌려줌 |
| GET | `/api/health` | - | DB 연결 확인 |

`online`은 보드의 마지막 보고가 10초 안에 있었는지를 뜻합니다.

curl 예시:

```bash
API=https://xiao-iot-api.onrender.com
TOKEN=$(curl -s -X POST $API/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"my-password"}' | python -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s $API/api/device -H "Authorization: Bearer $TOKEN"
curl -s -X POST $API/api/device/led -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"state":"toggle"}'
```

## 데이터베이스 (Supabase)

다른 서비스와 같이 쓰는 Supabase 프로젝트라서, 백엔드는 전용 Postgres 역할 `xiao_api`로 접속합니다.
이 역할은 아래 테이블에만 권한이 있습니다.

| 테이블 | 권한 |
| --- | --- |
| `xiao_users` | SELECT, INSERT |
| `xiao_sensor_logs` | SELECT, INSERT, DELETE |
| `xiao_devices` | SELECT, `led·touched·touch_value·threshold·rssi·updated_at` 열 UPDATE |

접속은 Supabase 트랜잭션 풀러(`aws-0-ap-northeast-2.pooler.supabase.com:6543`, 사용자 `xiao_api.<project-ref>`)를 거칩니다.
풀러는 prepared statement를 지원하지 않으므로 `prepare_threshold=None`으로 끕니다.

## 로컬 실행

```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt python-dotenv
cp .env.example .env   # 값 채우기
.venv/Scripts/python -m uvicorn main:app --host 0.0.0.0 --port 8010

cd ../frontend
python -m http.server 5500   # http://localhost:5500 → API는 http://localhost:8010 (config.js)
```

## 배포

- 백엔드: Render Web Service (Python, root `backend`, region Singapore, free)
  - Build: `pip install -r requirements.txt`
  - Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
  - 환경 변수: `DB_PASSWORD`, `JWT_SECRET`, `DEVICE_KEY`
  - 무료 플랜은 15분 동안 요청이 없으면 잠듭니다. 보드가 1초마다 보고하는 동안에는 깨어 있고, 보드가 꺼져 있으면 첫 요청에 30~60초가 걸릴 수 있습니다.
- 프론트엔드: `cd frontend && vercel deploy --prod`. API 주소는 `frontend/config.js`에 있습니다.
