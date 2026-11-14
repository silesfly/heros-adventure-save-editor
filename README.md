# 대협입지전 세이브 에디터 v1.0

## 개요
- 대협입지전(Hero's Adventure: Road to Passion / 大侠立志传)의 암호화된 `.save`를 로컬 오프라인에서 안전하게 편집하는 **Windows x64 단일 실행 파일 `HerosAdventureSaveEditor-v1.0.exe`** 정본 도구입니다.
- 브라우저 단일 HTML 보조판 `dist/HerosAdventureSaveEditor-v1.0.html` 및 무의존성 Python 3.8+ CLI `heros_adventure_editor.py`를 포함합니다.
- 인게임 메모리를 변조하는 트레이너가 아닌 정적 세이브 편집기이며, 원본 `.backup-*.bak` 생성과 SHA-256 해시 검증을 수행합니다.

## 설치와 실행 (`HerosAdventureSaveEditor-v1.0.exe` 기준)
- 환경: Windows 10/11 x64, .NET Framework 4.8 계열, Microsoft Edge WebView2 Runtime.
1. 게임(`Wulin.exe`)을 종료해 실행 중 저장을 차단합니다.
2. 세이브 폴더를 별도 사본으로 보관합니다.
3. `HerosAdventureSaveEditor-v1.0.exe`를 실행합니다.
4. `[네이티브 슬롯 열기]`로 `%USERPROFILE%\AppData\LocalLow\DefaultCompany\Wulin\<SteamID64>\Save0`(또는 `AutoSave0`/`QuickSave0`)을 선택하고, `Global\SaveObjectGameGlobal.save` 가원 공유 데이터를 자동 탐색·연동합니다.
5. 편집하며 실시간 변경 이력을 확인합니다.
6. `[자동 백업 저장]` 클릭 시 원본 `.backup-날짜-고유번호.bak` 생성 및 SHA-256 검증 후 저장합니다.

## 지원 편집 범위 (6개 탭)
| 탭 | 편집 범위 |
|---|---|
| 1 `요약 & 원클릭 프리셋` | 주인공 요약, 실시간 변경 이력, 파일별 초기화·다운로드, 원클릭 프리셋 6종(`재물 꾸러미`, `주인공 핵심 최대`, `생활 기술 전부`, `주인공 덕망 최대`, `파티 무공 최대`, `장원 전부 최대`). |
| 2 `화폐 & 파티 상태` | 동전(`1,000문 = 1관` 환산)·금원보·문파 공헌도·통천탑 화폐·SLG 화폐 등 10종 화폐 및 대오 체력·기분(`队伍体力`·`队伍心情`) 편집. |
| 3 `인벤토리 & 아이템 도감 (2,617종)` | 보유 수량(`m_stack`)·단조 레벨(`forgeLevel`)·삭제, 2,617종 한글 아이템 도감 검색·분류/등급 필터·스택 병합 및 비스택 장비 개별 추가. |
| 4 `주인공 & 동료 편집` | 파티원·명명 NPC·전체 인물 필터, 이름·칭호·레벨·경험치·체력/내력·성향·영입 상태, 5대 능력치(핵심·전투·병기·품성·26종 생활 기술 `m_originProps`/`m_additionProps`), 766종 무공 도감 습득·성급, 508종 특성 도감 추가·제거, 인연 호감도(`-100~100`) 편집·추가. |
| 5 `문파 · 가원 · 통천탑 · 시간` | 250문파 발견·우호도, 가원 7대 건물(`화청천·천공방·약선방·뒷산·오도비·진보각·정방`) 레벨(`SaveObjectGame.save` + `Global\SaveObjectGameGlobal.save` 동시 동기화), 통천탑 층수·점수, 게임 시간(년·월·일·십이지 시진·각). 같은 역할의 후보가 여러 개여도 유효한 정식 파일명(`SaveObjectGame.save`, `Global\SaveObjectGameGlobal.save` 등)이 하나 확인되면 비정식 복제본 수와 무관하게 해당 정식 파일을 선택합니다. 고유한 정식 파일 없이 비정식 복제본끼리 경합하거나 정식 파일 자체가 중복·손상된 경우에는 쓰기를 사전에 거부합니다. |
| 6 `REA 수식 · 90혈도 & Raw 뷰어` | 역공학 전투/피해 공식 및 사회·호감도 임계값, 6경맥(`독맥·임맥·양유맥·음유맥·충맥·대맥`) 90혈도 사전, 복호화 Raw ES3 JSON 열람·복사·다운로드. |

프리셋은 현재 선택한 세이브에만 적용되며, 적용 전 변경 이력과 백업 파일을 확인하세요.

## 백업과 복원 절차

- **저장 시 백업 및 롤백 보장**
  - 역할별 후보 중 유효한 정식 파일명(`SaveObjectGame.save`, `SaveObjectGameGlobal.save` 등)이 하나뿐이면 비정식 사본이 몇 개든 그 정식 파일을 사용하며, 고유한 정식 파일 없이 비정식 사본들이 경합하거나 정식 파일 자체가 중복·손상되었으면 모호/손상 상태로 보고 쓰기를 거부합니다.
  - 원본을 수정하기 전에 항상 로드 시점 SHA-256 일치 여부를 검증하고, 수정 대상 옆에 검증 완료된 `.backup-...bak` 백업 파일을 먼저 확보합니다.
  - **Windows 정본 `.exe` (`SaveStore.cs`)**: 모든 대상 원본을 `FileShare.None` 배타 핸들로 먼저 잠그고 심볼릭 링크(리파스 포인트)·UNC 경로 및 로드 시점 SHA-256을 검증한 뒤, 부모 디렉터리 핸들 고정(`PinParentDirectory`)과 배타적 핸들 이름 변경으로 `<파일명>.backup-<타임스탬프>-<고유번호>.bak` 백업을 원자적으로 생성·재검증하고 `FileShare.Read`로 열어 보존합니다. 이후 잠긴 원본 핸들에 직접 쓰기·플러시·해시 검증(`WriteAndVerify`)을 수행하며, 처리 가능한 쓰기 예외 발생 시 잠긴 핸들 위에서 역순 자동 롤백을 수행합니다. 단, 다중 파일 직접 쓰기 도중 프로세스 강제 종료나 전원 장애가 발생하면 예외 롤백이 실행되지 않아 파일 간 상태가 불일치하거나 쓰던 원본이 불완전할 수 있으므로, 이 경우 보존된 검증 완료 `.bak` 파일로 아래 수동 복원 4단계를 수행합니다.
  - **Python CLI (`heros_adventure_editor.py`)**: 읽기·복호화·암호화·쓰기 전 과정에서 부모 디렉터리 핸들/파일 디스크립터(`O_DIRECTORY | O_NOFOLLOW` 또는 Win32 디렉터리 핸들)를 고정해 심볼릭 링크·특수 파일·UNC 경로를 차단하고 `.hase-lock-*` 잠금을 획득합니다. 다중 파일 저장 시 모든 파일의 `.bak`과 `.pending-*.tmp`를 배타적 비덮어쓰기 게시(`hardlink`, Linux `RENAME_NOREPLACE`, Windows 비덮어쓰기 이름 변경)로 먼저 준비·검증한 뒤 커밋 직전 존재 여부와 SHA-256을 재확인하고 원자적 교체(`replace`)를 수행합니다. 교체 즉시 커밋 완료로 등록하여 후속 단계 실패 시 `.rollback-*.tmp` 스테이징 및 대상 존재·inode·SHA-256 재확인 후 역순 격리 롤백을 수행하며, 롤백 실패 또는 외부 수정/삭제 감지 시 외부 상태를 보존하고 수동 복구용 `.bak` 경로를 보고합니다.
- **수동 복원 4단계**
  1. 게임과 에디터를 모두 종료합니다.
  2. 현재 슬롯 파일을 별도 위치에 복사해 둡니다.
  3. 복원할 `.bak` 파일을 복사한 뒤 원래 파일명(예: `SaveObjectPlayerTeam.save`)으로 변경합니다.
  4. 인게임에서 슬롯 로드가 정상인지 확인합니다.
- **Steam Cloud 주의**: 동기화가 켜져 있으면 원격 파일로 덮어써질 수 있으므로 동기화 상태를 확인하세요.

## 보조 실행 수단

- **브라우저 오프라인 단일 파일** — `dist/HerosAdventureSaveEditor-v1.0.html`
  - 외부 네트워크 요청이 없는 단일 HTML입니다.
  - `[슬롯 폴더 열기]`(`webkitdirectory`) 또는 `[개별 .save 파일 열기]`로 세이브를 불러오고 수정된 `.save` 파일을 다운로드하여 내보냅니다.
  - 웹 브라우저의 `FileSystemFileHandle`은 최종 검증과 `close()` 커밋 사이의 외부 변경 충돌을 원자적 배타 잠금/CAS로 차단할 수 없으므로 브라우저 직접 폴더 덮어쓰기는 fail-closed로 차단됩니다. 원본 폴더 자동 `.bak` 백업과 직접 저장이 필요하면 Windows `.exe`의 `[자동 백업 저장]`(배타 잠금·검증된 `.bak` 백업 확보 및 처리 가능한 예외 시 자동 롤백 기반 직접 저장)을, 검증된 `.bak` 확보 및 `.pending` 스테이징 후 원자적 파일 교체·역순 격리 롤백이 필요하면 Python CLI `edit` 명령을 이용하세요.
- **무의존성 Python 3.8+ CLI** — `heros_adventure_editor.py`
  - 서드파티 패키지 없이 표준 라이브러리만으로 동작합니다.
  - `inspect` / `decrypt` / `encrypt` / `edit` / `serve` 명령을 제공합니다.
  - `decrypt` / `encrypt`는 출력 파일이 이미 있으면 기본적으로 거부하며, 덮어쓸 때는 `--overwrite`로 `.bak` 백업 후 교체합니다.
  - `Wulin.exe` 실행 중 보호 검사를 우회해야 할 때만 `--ignore-running-game`(또는 호환 별칭 `--force`)을 사용합니다.
  - 빌드 스크립트 `build.py`는 Python 3.8+ 이상에서 동작합니다.

```bash
python3 heros_adventure_editor.py inspect ./Save0
python3 heros_adventure_editor.py decrypt ./Save0/SaveObjectPlayerTeam.save -o ./work/player_team.json --overwrite
python3 heros_adventure_editor.py encrypt ./work/player_team.json -o ./work/SaveObjectPlayerTeam.save --mode aes-gzip --overwrite
python3 heros_adventure_editor.py edit ./Save0 --preset wealth_package --preset fief_all_max --coin 99999999 --update-timestamp
python3 heros_adventure_editor.py serve --host 127.0.0.1 --port 8765
```

## 소스 빌드 및 자동화 테스트

- **Windows `.exe` + `.html` 동시 빌드**: `.NET Framework 4.x csc.exe` 사용
  - `.\vendor\webview2`에 `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, `WebView2Loader.dll`, `LICENSE.txt`가 필요합니다.

```powershell
python build.py --exe --webview2 .\vendor\webview2
```

- **HTML 단독 번들 빌드**

```bash
python3 build.py
```

- **테스트**

```bash
node tests/test_editor.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
```

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /out:SaveStoreTests.exe src\SaveStore.cs tests\SaveStoreTests.cs
.\SaveStoreTests.exe .\test-store-out
.\dist\HerosAdventureSaveEditor-v1.0.exe --self-test .\test-selftest-out
```

## REA 역공학 세이브 규격 요약

- **컨테이너**: Unity Easy Save 3의 4개 모드(`aes-gzip` 기본, `aes-plain`, `gzip`, `plain`)를 사용합니다.
- **암호화 모드**
  - `aes-gzip` 저장 시: **UTF-8 평문 인코딩 → GZip 압축 → 선두 16바이트 랜덤 IV(겸 salt) + `PBKDF2-HMAC-SHA1("Meow", iv, 100회, 16B)` 파생 키 `AES-128-CBC`(PKCS#7 패딩) 암호화** 순서로 처리합니다.
  - `aes-gzip` 복호화 시: 역순인 **AES-128-CBC 복호화 → GZip 압축 해제 → UTF-8 디코딩** 순서로 처리합니다.
  - `aes-plain`은 GZip 단계를 생략하고, `gzip`/`plain`은 AES 단계를 생략합니다.
- **AST 무손실 보존**
  - 표준 `JSON.parse`가 거부하는 비표준 비인용 정수·음수 키(`0:50000`, `-1:[100401,10005]`)와 키 순서를 보존합니다.
  - 64비트 정수(`ticks`, `ThirdPlatformId`)와 128비트 `Decimal`(`QuaterOfDay`) 원문 문자열을 무손실 유지합니다.
  - 이를 위해 전용 ES3 JSON AST 파서·직렬화기를 사용합니다.
