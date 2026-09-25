-- 수업 복기 API 로컬 통합 시험 픽스처(scripts/review-e2e.cjs) — 전부 가짜 값 · 운영 DB 에 실행 금지(표를 비운다)
\set ON_ERROR_STOP on
-- 안전장치: 시험 DB(revtest · 이름에 e2e 포함)에서만 돈다. 운영(postgres)에서는 여기서 멈추고 아래는 실행되지 않는다.
do $$ begin
  if current_database() <> 'revtest' and current_database() not like '%e2e%' then
    raise exception 'review-e2e.seed.sql 은 시험 DB 에서만 실행 — 현재 %', current_database();
  end if;
end $$;
-- 가짜 픽스처(실데이터 아님)
truncate public.lesson_reviews, public.course_attendance, public.course_sessions, public.courses, public.lesson_sessions restart identity cascade;
delete from public.students where id between 100 and 199;
delete from public.staff where id between 1 and 9;
insert into public.staff (id, discord_id, name, role, active) overriding system value values
  (1, 'd-t1', 'TrainerA', 'trainer', true), (2, 'd-o2', 'OwnerO', 'owner', true), (3, 'd-t3', 'TrainerOld', 'trainer', false),
  (4, 'd-t4', 'TrainerB', 'trainer', true);   -- PR-3: 담당·최근 수업 없는 활성 트레이너(공개 복기만 읽는 열람자)
insert into public.students (id, name, discord_nick, trainer_id, status, pubg_name, pubg_platform) overriding system value values
  (101, 'TestStudentOne',   'dn1', 1, 'active', 'Test_User1', 'steam'),
  (102, 'TestStudentTwo',   'dn2', 1, 'active', null, null),
  (103, 'TestStudentThree', null,  1, 'done',   null, null),
  (104, 'TestStudentFour',  null,  1, 'done',   'Test_User4', 'kakao'),
  (105, 'TestStudentFive',  null,  null, 'active', null, null);
insert into public.lesson_sessions (id, student_id, trainer_id, played_at, games) overriding system value values
  (1001, 101, 1, (now() at time zone 'Asia/Seoul')::date,        3),
  (1002, 101, 3, (now() at time zone 'Asia/Seoul')::date - 10,   3),
  (1003, 101, 2, (now() at time zone 'Asia/Seoul')::date - 20,   3),
  (1004, 102, 1, (now() at time zone 'Asia/Seoul')::date,        3),
  (1005, 103, 1, (now() at time zone 'Asia/Seoul')::date - 200,  3),
  (1006, 104, 1, (now() at time zone 'Asia/Seoul')::date - 30,   3);
insert into public.courses (id, student_id, level, scheme, session_minutes, unit_price, started_on) overriding system value values
  (201, 101, '초급반', 'new', 120, 10000, (now() at time zone 'Asia/Seoul')::date - 30),
  (202, 102, '초급반', 'new', 120, 10000, (now() at time zone 'Asia/Seoul')::date - 30);
insert into public.course_sessions (id, held_on, duration_min) overriding system value values
  (301, (now() at time zone 'Asia/Seoul')::date - 5, 120),
  (302, (now() at time zone 'Asia/Seoul')::date - 3, 120);
insert into public.course_attendance (session_id, course_id, units) values (301, 201, 1), (302, 202, 1);
