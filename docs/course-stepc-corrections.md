# STEP C — 강의(courses) 축 정정 2건 · ✅ **위임 실행 완료 (2026-08-25 밤)**

> **검토 승인 → 위임 실행 완료.** 사후검증 전부 기대 일치(원시): courses 8→**15**행
> (신규 id 9~15) · kind=course 미연결 2→**0**(#162→course 15 · #166→course 11) ·
> 엄태현 **paused** · 김웅채 **0행** · started_on 5행 정정 반영(3=04-15 · 4=03-04 ·
> 6=05-01 · 7=05-01 · 8=05-24 · 5=04-21 불변).
> **전제 정정 수용(관제탑 실측)**: trainer_id는 NOT NULL이 아니라 선택 컬럼 —
> 「NOT NULL 2컬럼」 표현은 session_minutes만 해당. 단 null 방치 시 담당 없는 계약이
> 되므로 **4(원장) 명시 승인**대로 넣어 실행했다. 단가 3종(21,000/23,000/30,000) 전부
> 정수 — #137형 memo 우회 불요 확인. 이하 발행 원문 보존.
> 6회까지 별도 메시지가 전부 유실됐고 7회차에 지시 본문 인라인으로 최초 수신됐다.
> 실측 대조(2026-08-25 밤): 정정 ① 대상 6명의 **현 DB 값이 관제탑 구값과 전부 일치**
> (courses id 3~8) · 신규 7명 전원 **명부 단일 매칭·courses 미존재**(중복 0) ·
> 김웅채(#22)는 표 제외 확정과 일치(courses 0행·students done).

## 0. 실측 전제 2건 — 검토 시 확인 요청

관제탑 표에 없는 두 컬럼(둘 다 NOT NULL)은 **기존 직강 8행 전례**로 전제했다:

| 컬럼 | 전제값 | 근거 |
|---|---|---|
| `session_minutes` | **180** | 기존 8행 전부 180 (id 3 실측) |
| `trainer_id` | **4** (원장) | 기존 8행 전부 4 — 직강 축 |

레벨 표기는 CHECK(`초급반·중급반·심화반·개인강의·기타`)에 맞춰 「중급」→`중급반` 등으로
매핑했다. 「완료·잔액」 열은 courses에 컬럼이 없어(계약 정보만 보유) **memo에 기록**한다 —
회차 차감 정본은 시트/정산 축이고 courses는 계약(회차·단가·개시일)이다.

## 1. 정정 ① — `started_on` 5행 UPDATE (결제일 → 신청일자)

출처: MRI_주간_스케쥴.xlsx · MRI_전체현황 탭 신청일자 열. courses.id 유지.
김준성(id 5)은 2026-04-21로 **일치 — 변경 없음**(6명 중 5행만 UPDATE).

```sql
update public.courses set started_on = v.d::date, updated_at = now()
  from (values (4, '2026-03-04'),   -- 양형석: 04-03 → 03-04
               (6, '2026-05-01'),   -- 박선우: 04-10 → 05-01
               (3, '2026-04-15'),   -- 권태완: 04-11 → 04-15
               (7, '2026-05-01'),   -- 길영패: 05-06 → 05-01
               (8, '2026-05-24'))   -- 양정현: 06-06 → 05-24
       as v(id, d)
 where public.courses.id = v.id;
-- 기대: UPDATE 5. started_on은 FIFO·회차 차감 기준이라 STEP D보다 선행(관제탑).
```

## 2. 정정 ② — STEP C-2 courses 신규 7행 (전부 `scheme='old'` · 신체계 역산 금지)

오너 확정 반영: 엄태현 **`paused`**·잔액 792,000 보존(소멸·환불 금지) · **김웅채 시드
제외**(입금 미확인 — students 결제대기 유지).

```sql
insert into public.courses
  (student_id, level, scheme, session_minutes, unit_price, units_total, started_on, status, source, trainer_id, memo)
select v.sid, v.lv, 'old', 180, v.up, v.ut, v.d::date, v.st, 'sheet_import', 4, v.memo
  from (values
    (38, '중급반', 21000, 36, '2025-09-27', 'paused',
     'STEP C-2 · 누적 2,352,000 · 완료 47 · 잔액 792,000 보존(오너 확정: 수강 중단·내년 재개 가능성·소멸·환불 금지) · owner_sql'),
    (14, '심화반', 23000, 24, '2025-07-26', 'active',
     'STEP C-2 · 누적 552,000 · 완료 17 · 잔액 23,000 · owner_sql'),
    (56, '중급반', 21000, 36, '2026-01-16', 'active',
     'STEP C-2 · 누적 806,000 = 360,000+192,000+254,000(3차 = P-1 payments#166 연결) · 완료 34 · 잔액 92,000 · 1·2차는 원장 개시 이전 — 시드 없음 · owner_sql'),
    (89, '심화반', 30000, 12, '2026-02-23', 'active',
     'STEP C-2 · 누적 360,000 · 완료 9 · 잔액 90,000 · owner_sql'),
    (88, '심화반', 30000, 12, '2026-03-07', 'active',
     'STEP C-2 · 누적 360,000 · 완료 7 · 잔액 150,000 · owner_sql'),
    (9,  '초급반', 30000, 12, '2026-05-25', 'active',
     'STEP C-2 · 누적 120,000 · 완료 1 · 잔액 90,000 · owner_sql'),
    (25, '심화반', 30000, 12, '2026-06-15', 'active',
     'STEP C-2 · 누적 360,000(P-1 payments#162 연결) · 완료 15 = -3회(-90,000) · 미기입 5건 반영 시 -8회(-240,000) — 미수는 오너 판정 대기 등재 · owner_sql')
  ) as v(sid, lv, up, ut, d, st, memo)
 where not exists (select 1 from public.courses c where c.student_id = v.sid and c.started_on = v.d::date);
-- 기대: INSERT 7 (멱등 — 학생×개시일 재실행 차단)
```

## 3. 연결 — P-1 미연결 결제 2행 → 신규 course_id

P-1 실측: 박성민 = `payments #162`(6/12 · 360,000) · 신종근 = `payments #166`(3/18 ·
254,000 — 3차분). W-5(신종근 계약 회차 불명)는 이 표(units_total 36)로 해소된다.

```sql
update public.payments p set course_id = c.id
  from public.courses c
 where p.id = 166 and p.course_id is null and c.student_id = 56 and c.started_on = date '2026-01-16';
update public.payments p set course_id = c.id
  from public.courses c
 where p.id = 162 and p.course_id is null and c.student_id = 25 and c.started_on = date '2026-06-15';
-- 기대: UPDATE 1 + 1 → kind='course' 미연결 0행
```

## 4. 사후검증 · 기대

```sql
-- ① courses 8 → 15행 · 정정 5행 반영(4=03-04 · 6=05-01 · 3=04-15 · 7=05-01 · 8=05-24 · 5=04-21 불변)
select id, student_id, started_on::text, status, scheme from courses order by id;
-- ② P-1 미연결: 2 → 0
select count(*) from payments where kind='course' and course_id is null;
-- ③ 엄태현(38) paused 1행 · 김웅채(22) 0행
select (select status from courses where student_id = 38) as um,
       (select count(*) from courses where student_id = 22) as woong;
```

## 5. 후속 등재

- **박성민 미수**: 완료 15회 = 계약 12회 대비 −3회(−90,000), 미기입 5건 반영 시
  −8회(−240,000) — **오너 판정 대기**(`settlement-corrections.md` W-8).
- 이 실행으로 `REQUIRED_SCHEMA`·코드 변경 없음(기존 컬럼·CHECK 전부 통과 실측).
- **W-5 해소**: 신종근 계약이 units_total 36·단가 21,000으로 확정 시드되고 P-1
  #166(254,000 · 3차)이 course 11에 연결됐다 — 「회차 불명·행 생성 불가」 보류 종료.

## 6. STEP D 재발행 — 예약 자리 (소스: 수업_로그 추출본 · 오너 제공 대기)

관제탑 8/25 밤 — STEP C 실행 완료로 STEP D 선행 해소. 오너가 수업_로그 추출본을
제공하면 재발행한다. **미기입 10건(8/4~8/22)을 이 발행에 반영한다**(관제탑 확정치):

| 학생 | 추가 회차 |
|---|---|
| 박성민 | +5 |
| 양정현 | +5 |
| 길영패 | +4 |
| 김해주 | +3 |
| 신종근 | +1 |
| 김준성 | +1 |
| 허혜민 | +1 |

⚠️ 검산 메모: 회차 합 = **20회**인데 표제가 「미기입 **10건**」 — 건(기입 행 수)과
회차(진행 수)가 다른 단위인지 추출본 수령 시 대조한다. 박성민 +5 반영 시 미수가
−90,000 → **−240,000**으로 커진다(W-8 판정 재료).
