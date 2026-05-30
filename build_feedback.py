# -*- coding: utf-8 -*-
"""
MRI ACADEMY 레슨생 피드백 관리 페이지 생성기
- 현태 트레이너의 per-레슨생 코칭 로그를 구조화 → lesson-feedback.html 생성
- 디스코드 per-레슨생 채널/팀톡을 대체하는 웹 관리 + 홍보용 뷰
- 데이터: 현태 레슨 피드백 메모(실데이터)를 전문적 톤으로 정리, 닉네임 기반
- 새 세션 추가: STUDENTS의 해당 레슨생 'sessions'에 {date, tags, points} 추가 후 재실행

커리큘럼 척추: 주도권 → 우선순위 → 포지션 → 강제  (+ 교전/운영/오더/피지컬)
"""
import html, datetime

TAGS = {
    "주도권":   "gold",
    "우선순위": "blue",
    "포지션":   "purple",
    "강제":     "red",
    "교전·투척":"green",
    "운영·빌드업":"golddeep",
    "오더·브리핑":"blue",
    "시야·판단":"gold",
    "피지컬":   "faint",
    "기본기":   "faint",
}

# (닉, 담당, 그룹, 티어/판수, [세션...], 동향요약)
# 세션: (날짜, [태그], [핵심 포인트])
STUDENTS = [
 # ===== 고티어 그룹 =====
 ("근이","현태","고티어","다이아·33판",[
   ("04/23",["주도권","우선순위"],["1·2·3티어 자리와 주도권 개념 정립, 방어/공격 우선순위 학습 시작","딜 전 적 전체 시야 확보 후 우선순위 선정, 정보 누락 방지"]),
   ("04/28",["포지션","시야·판단"],["본대 차량 운용 시 합류 판단, 날개 죽을 각 재점검","정리 가능 상황에서 선제적으로 시야 열어주기"]),
   ("05/04",["운영·빌드업","시야·판단"],["시야 밖으로 서클 변동 시 대비책 수립, 빈집 진입 차선책","오더에게 정보 콜, 한 템포 빠른 시야 확보"]),
   ("05/12",["운영·빌드업","교전·투척"],["고지대 스플릿 근거 수립, 연막+폭 후 연속 압박","4페 날개 버티며 밀어내기, acc·dcc 피킹"]),
 ],"기초 개념(주도권/우선순위)에서 출발 → 시야·턴 운영 단계로 안정적 발전"),

 ("덕덕","현태","고티어","마스터·33판·오더",[
   ("04/23",["교전·투척","오더·브리핑"],["교전 디테일(투척·연막) 보완, 베이팅 대응, 피킹 길이 조절","팀 콜 강도 우수"]),
   ("04/28",["오더·브리핑","우선순위"],["오더 시 팀 우선순위 정확히 파악, 본대 복귀 원칙","각 인지 강화"]),
   ("05/04",["오더·브리핑","운영·빌드업"],["폭거리 인지, 선제 정보 수집, 위기 상황에도 오더 유지","메인오더 중심 유지, 다각도 플랜 수립"]),
 ],"오더 역량 집중 트랙 — 우선순위 파악 → 위기 오더 지속 → 다각도 플랜"),

 ("엄티","현태","고티어","다이아·33판",[
   ("04/23",["오더·브리핑","우선순위"],["자기주도적 브리핑 강화, 턴 잡는 속도 개선","막을 우선순위·유리 지형 선점"]),
   ("04/25",["시야·판단","포지션"],["급할 때 맵·팀원 위치 확인 습관화","포지션 개념(엔트리/트레이드/커버) 정립"]),
   ("04/28",["오더·브리핑","운영·빌드업"],["라인 잡고 정보 공유·역할 분담으로 과부하 방지","우선순위 기반 자기 역할 수행"]),
   ("05/05",["운영·빌드업","피지컬"],["주도권 라인 진행 방향, 시야 밖 서클 대비","수류탄·피지컬 다듬기"]),
 ],"브리핑·소통 → 포지션·운영으로 확장, 피지컬 보완 단계"),

 ("레드","현태","고티어","오더·빌드업",[
   ("05/05",["운영·빌드업","강제"],["푸쉬 시 폭턴·엄폐, 수비 우선순위 예측 포지션","본대 선확보 후 교전, 이이제이 대기"]),
   ("05/09",["오더·브리핑"],["방향성·우선순위 명확 전달, 필드 교전도 우선순위 기반, 익절 판단"]),
   ("05/10",["운영·빌드업"],["서클 예측 빌드업, 반대 전개 대비, 4페 이후 빌드업 수행"]),
   ("05/15",["포지션"],["무리한 각 벌리기 자제, 팀원과 같은 각 활용"]),
   ("05/16",["강제"],["강제 개념(상대 선택지 축소), 포지션으로 강제 성립, 1티어 고지대 경험"]),
   ("05/18",["운영·빌드업"],["다음 서클 주도권용 포지션, 밀기 전 팀 인지, 회전 시 고지대 시야"]),
   ("05/20",["오더·브리핑","교전·투척"],["겹칠 팀 인지·본대 의도 전달, 인포 수용, 교전 포탑면·속도 맞춤","후반 급해지는 버릇 교정, DMR 피킹 룰 정립"]),
   ("05/21",["강제","운영·빌드업"],["1선 강제 대처 사전 인지, 1:1 쇼부 습관 교정, 4~8페 빌드업 보완"]),
   ("05/23",["오더·브리핑"],["다양한 오더 방식·구도 고민, 셀프 피드백 습관"]),
 ],"교전 디테일 → 오더·빌드업·강제까지 폭넓게, 1:1 쇼부 습관 교정 진행 중"),

 ("해주","현태","고티어","마스터",[
   ("05/19",["포지션","시야·판단"],["본대 인식 속도, 본대 합류 vs 날개 판단","자리 확신, 시야 따는 타이밍(3페까지), 위기 콜"]),
   ("05/19",["운영·빌드업"],["미라마 레드바위·창고 시야 가치 이해, 안→밖 진행 용이성 개념"]),
   ("05/20",["운영·빌드업","교전·투척"],["인포 타이밍 확보, 소극성 교정","연막 공격적 운용(준구 피드백)"]),
   ("05/23",["오더·브리핑"],["동선 제시형 브리핑(핑 의존 탈피), 팀 콜 신뢰·세이브"]),
 ],"본대 판단·자리 확신 강화, 브리핑 질 상승 단계"),

 # ===== 그룹레슨 =====
 ("배로","레빗·현태","그룹","골드·33판",[
   ("04/24",["포지션"],["방어/공격 포지션 4역할 정립, 빽업·합류 규칙, 방어 시 연막 선행"]),
   ("04/25",["피지컬"],["템포·공격성 향상, 무빙 사격·차량 자리이동 따닥, 견착 조준 루틴"]),
   ("05/01",["우선순위","교전·투척"],["자기장 변동 후 우선순위 선택, 연막 안 플레이·수류탄 은폐 보완"]),
   ("05/02",["교전·투척","운영·빌드업"],["견착 싸움, 끝각 역할 유지, 일반/경쟁 자기장 속도 차, 날개 오더 콜"]),
   ("05/07",["교전·투척"],["차량 교전 시 연막 선행·시야 체크, 투척 회피"]),
   ("05/14",["운영·빌드업","교전·투척"],["연막 공격적 운용, 땅 확보, 1·2·3티어 대비 수","폭랜딩·5발 후 엄폐, 날개 역할 소멸 시 합류"]),
   ("05/16",["포지션"],["1선 다운 시 공격적 어그로 전환, 2선 신규 라인, 날개 끝각 적극성"]),
   ("05/21",["포지션","오더·브리핑"],["포지션 겹침 시 방향 공유, 시야 확장 적극성, 오더 우선순위 맞춤"]),
   ("05/24",["운영·빌드업"],["1선 끝각 클리어→2·3선 충원, 비알디엠 운영(날개 견제)"]),
   ("05/26",["운영·빌드업"],["날개 부러질 때 후방 재라인, 서클 변동 시 필요한 교전"]),
   ("05/28",["운영·빌드업","교전·투척"],["고지대 선점 콜, 180도 양각 시 개입 고려, 턴 살리기","라이딩 1선 결정, 자리 방어 3분할 연막 (준구 레슨)"]),
 ],"포지션·피지컬 기초 → 교전·운영 디테일로 꾸준히 심화, 가장 성실한 레슨생"),

 ("콩가","현태","그룹","실버·33판",[
   ("04/24",["포지션","주도권"],["주도권·우선순위·포지션 3축 정립, 방어/공격 포지션"]),
   ("04/30",["교전·투척"],["1:1 대치 투척 활용, 건물 클리어 순서(1층부터)"]),
   ("05/08",["오더·브리핑","교전·투척"],["기절 후 적극 브리핑, V자 방어주차, 투척 거리, 위치·지명 학습"]),
   ("05/14",["교전·투척"],["견착 피킹 습관, 포탑 시야 내 교전, 1·2·3티어 자리 인지"]),
   ("05/20",["포지션"],["1선-포탑 역할 교차 전진, 클리어 시 백업 동선 예측"]),
   ("05/26",["운영·빌드업"],["위협사격 자리 방어, 인서클 사주경계, 끝각 관리, 차량 돌입 대응"]),
 ],"기본기(클리어·투척)부터 차근차근, 수비 운영까지 확장"),

 ("다다","현태","그룹","자영업·유동",[
   ("05/17",["오더·브리핑","시야·판단"],["배그=정보 싸움, 생각 브리핑, 시야 분담, 단차 어그로 활용"]),
   ("05/20",["교전·투척","포지션"],["집 공략 순서, 포지션 4역할, 평지 교전 연막 루틴, 폭턴"]),
   ("05/22",["시야·판단"],["팀·맵 상시 확인, 빈자리 능동 충원"]),
   ("05/25",["시야·판단"],["본대 충원 우선, 맵 기반 판단, 지리 학습"]),
   ("05/26",["운영·빌드업"],["신뢰 기반 버티기, 후방 동선 경계, 6페 이후 도구 활용 교전"]),
 ],"브리핑·정보 습관화 → 판단·운영으로 빠르게 성장 (\"너무 잘하고 있음\" 코멘트)"),

 ("감자","현태·레빗","그룹","교대근무",[
   ("05/14",["기본기","오더·브리핑"],["소통, 자리 기본 개념(티어), 우선순위 인지, 기본기(엄폐·턴)"]),
   ("05/19",["오더·브리핑"],["경청·반응, 상대 윗각, 서브오더 역할(정보·선택지), 포탑각"]),
   ("05/22",["운영·빌드업"],["단차 체크 루틴(연막·포탑·시야), 빈 포지션 충원, 1:1 쇼부 자제"]),
   ("05/25",["운영·빌드업"],["우선순위 기반 치킨각, 포탑각 요청·시야 확보"]),
 ],"기본기 → 서브오더·운영 판단으로 발전"),

 ("구름","현태","그룹","",[
   ("04/27",["기본기","포지션"],["앉아쏘기, 포지션 개념, 딜보다 기본기 우선"]),
   ("05/17",["주도권","우선순위"],["주도권·우선순위, 뒷각·끝각, 페이즈별 티어 자리"]),
   ("05/26",["포지션"],["공/수 포지션, 끝각 원칙(브리핑에 안 빨림), 능동적 위치 탐색"]),
 ],"기본기 → 주도권·포지션 개념 정립"),

 ("지훈","현태","그룹","",[
   ("05/19",["포지션","교전·투척"],["공/수 포지션 순환, 라이딩보다 팀 콜 활용, 차량 활용"]),
   ("05/26",["시야·판단"],["뒷각 클리어 후 전방 시야·자리 충원, 본대 외 자리는 시야용"]),
 ],"포지션 개념 → 시야·자리 운용"),

 ("성인","현태","그룹","",[
   ("05/08",["오더·브리핑"],["전체 브리핑, 시야 공유, 자아 있는 플레이, 과감성 균형"]),
   ("05/14",["운영·빌드업","우선순위"],["티어 서클, 본대 생존, 우선순위 빽업, 마지노선"]),
 ],"브리핑·자아 → 수비 운영"),

 ("미쯔","현태","그룹","플레·10판",[
   ("04/25",["주도권","포지션"],["근거 있는 플레이, 주도권·우선순위, 1234선 포지션, 끝각 원칙"]),
 ],"입문 — 핵심 개념 일괄 정립"),

 ("제이","현태","그룹","10판",[
   ("04/22",["시야·판단"],["뇌정지·멀티 보완, 3티어 자리 인지, 불필요 SR 피킹 자제"]),
   ("05/01",["교전·투척","오더·브리핑"],["눈먼 공투 자제·쿠킹 투척, 적극 정보 공유, 라이딩 욕심 자제"]),
 ],"멀티·소통 보완 진행"),

 ("불리","현태","그룹","마스터·10판",[
   ("04/30",["교전·투척"],["차량 교전 연막 선행, 엄폐 없는 교전 자제, 콜에 안 빨림"]),
   ("05/01",["오더·브리핑"],["행동 브리핑 후 이동, 각 이해 보완, 소통"]),
   ("05/10",["교전·투척"],["연막·엄폐 습관화"]),
   ("05/16",["주도권","강제"],["주도권→우선순위→포지셔닝→강제 체계, 서클 주도권·티어 경쟁 동선","끝각 역할, 딜 위치(1티어끼리)"]),
 ],"교전 습관 교정 → 전체 이론 체계 정립"),

 ("victor lee","현태","그룹","C그룹",[
   ("05/06",["주도권","시야·판단"],["주도적·사전 공유, 시야 각 인지, 지형·투척"]),
   ("05/08",["주도권"],["거점 주도권·1·2·3티어, 지형 숙지, 사전 공유"]),
   ("05/20",["포지션"],["공/수 포지션, 2층 집 공략, 팀 공유"]),
 ],"주도권·지형 입문 → 포지션"),

 ("쭌","현태","개인",  "",[
   ("04/27",["포지션","교전·투척"],["지형 명칭, 투척·팀원 활용, 안전 포탑"]),
   ("05/15",["포지션"],["포탑 시야 푸쉬, 날개 안 빨림"]),
   ("05/18",["교전·투척"],["연막 선행"]),
 ],"개인레슨 — 지형·포지션 이론 정립"),

 ("록라니","현태","그룹","",[
   ("05/19",["주도권","강제"],["행동 전 브리핑, 주도권·우선순위, 날개 실수 교정, 강제 시도"]),
 ],"개념 정립 입문"),

 ("건희","현태","그룹","",[
   ("05/19",["우선순위","오더·브리핑"],["수비 우선순위, 서브오더 역할, 본대 빨림 방지"]),
 ],"우선순위·서브오더 입문"),
]

# ── 공개 전환 대상 (수강종료/목표달성 시 여기에 닉:정리요약 추가하면 공개 페이지에 노출) ──
# 비어있는 레슨생은 비공개(관리용 admin 페이지에만 표시). 기본은 전원 비공개.
PUBLIC = {
 "배로": "골드에서 출발해 포지션·피지컬 기초부터 교전·운영 디테일까지 12회 누적 코칭. 가장 꾸준히 성장한 레슨생으로, 연막 운용·끝각 판단이 안정 단계에 진입했습니다.",
 "근이": "기초 개념(주도권·우선순위)에서 시작해 시야·턴 운영까지 단계적으로 완성. 본대 합류 판단과 빌드업을 자력으로 수행하는 수준에 도달했습니다.",
 "다다": "정보·브리핑 습관화에서 출발해 짧은 기간 내 판단·운영까지 빠르게 성장. 본대 판단과 후방 경계가 자리잡아 트레이너가 성장 속도 최상으로 평가했습니다.",
}

# ── 시즌별 정량 추이 (평균딜·티어) ────────────────────────
# 닉네임: [(시즌라벨, 평균딜, 티어), ...]   2개 이상이면 그래프 표시, 없으면 생략
# PUBG API 연동(5일 후) 시 수강생 닉네임 매핑으로 자동 채움. 그 전엔 시즌별 딜 수동 입력.
PROGRESS = {
    # 예시: "근이": [("33S", 240, "다이아"), ("34S", 291, "다이아"), ("35S", 336, "크리스탈")],
}

TIER_COLORS = {
    "브론즈":"#a16207","실버":"#9ca3af","골드":"#f5c518","플래티넘":"#5ac8fa","플래":"#5ac8fa",
    "크리스탈":"#a855f7","다이아몬드":"#38bdf8","다이아":"#38bdf8","마스터":"#e63946","서바이버":"#10b981",
}
def tier_color(t):
    for k,c in TIER_COLORS.items():
        if k in (t or ""): return c
    return "#a1a1aa"

def spark_svg(rows):
    """시즌별 평균딜 미니 라인그래프 + 티어 변화. rows=[(시즌,딜,티어)] 최소 2개."""
    if not rows or len(rows) < 2:
        return ""
    dmgs = [r[1] for r in rows]
    lo, hi = min(dmgs), max(dmgs)
    span = (hi - lo) or 1
    W, H, padX, padTop, padBot = 280, 74, 26, 18, 22
    n = len(rows)
    xs = lambda i: padX + i*(W-2*padX)/(n-1)
    ys = lambda v: padTop + (1-(v-lo)/span)*(H-padTop-padBot)
    pts = [(xs(i), ys(r[1])) for i,r in enumerate(rows)]
    poly = " ".join(f"{px:.1f},{py:.1f}" for px,py in pts)
    dots = labels = ""
    for r,(px,py) in zip(rows, pts):
        dots += f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3" fill="var(--gold)"/>'
        labels += f'<text x="{px:.1f}" y="{py-7:.1f}" text-anchor="middle" font-size="9" fill="var(--gold)" font-weight="700">{r[1]}</text>'
        labels += f'<text x="{px:.1f}" y="{H-6}" text-anchor="middle" font-size="8" fill="var(--ink-faint)">{html.escape(str(r[0]))}</text>'
    delta = dmgs[-1] - dmgs[0]
    dcolor = "var(--green)" if delta >= 0 else "var(--red)"
    dsign = "+" if delta >= 0 else ""
    t0, t1 = rows[0][2], rows[-1][2]
    tier_row = (f'<span class="tchip" style="color:{tier_color(t0)}">{html.escape(t0)}</span>'
                f'<span class="tarr">→</span>'
                f'<span class="tchip" style="color:{tier_color(t1)}">{html.escape(t1)}</span>')
    return f'''<div class="dchart">
  <div class="dctop"><span class="dctitle">시즌별 평균딜 추이</span><span class="dcdelta" style="color:{dcolor}">{dsign}{delta}</span></div>
  <svg viewBox="0 0 {W} {H}" class="dcsvg" preserveAspectRatio="xMidYMid meet">
    <polyline points="{poly}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    {dots}{labels}
  </svg>
  <div class="dctier">{tier_row}</div>
</div>'''

def chip(t):
    c = TAGS.get(t,"faint")
    return f'<span class="tg {c}">{html.escape(t)}</span>'

def render(mode="admin"):
    pub = (mode=="public")
    pool = [s for s in STUDENTS if s[0] in PUBLIC] if pub else STUDENTS
    total_students = len(pool)
    total_sessions = sum(len(s[4]) for s in pool)
    groups = {}
    for st in pool:
        groups.setdefault(st[2], []).append(st)
    order = ["고티어","그룹","개인"]
    gnames = {"고티어":"고티어 그룹","그룹":"그룹 레슨","개인":"개인 레슨"}

    cards_html = ""
    for g in order:
        if g not in groups: continue
        cards_html += f'<div class="grp-title">{gnames[g]} <span>{len(groups[g])}명</span></div>\n<div class="cards">\n'
        for nick,owner,grp,meta,sessions,trend in groups[g]:
            seen=[]
            for _,tags,_ in sessions:
                for t in tags:
                    if t not in seen: seen.append(t)
            stage_chips = "".join(chip(t) for t in seen)
            tl = ""
            for date,tags,pts in sessions:
                tagh = "".join(chip(t) for t in tags)
                pth = "".join(f"<li>{html.escape(p)}</li>" for p in pts)
                tl += f'<div class="sess"><div class="sd">{html.escape(date)}</div><div class="sb">{tagh}<ul>{pth}</ul></div></div>\n'
            meta_h = f' · {html.escape(meta)}' if meta else ''
            disp_trend = PUBLIC[nick] if pub else trend
            badge = '<span class="cnt pubb">✓ 성장 사례</span>' if pub else f'<span class="cnt">{len(sessions)}세션</span>'
            chart = spark_svg(PROGRESS.get(nick))
            if not chart and not pub:
                chart = '<div class="dcph">📊 시즌별 딜·티어 추이 — PUBG 연동 시 자동 표시</div>'
            cards_html += f'''<details class="sc"{' open' if pub else ''}>
<summary>
  <div class="hd">
    <div><span class="nk">{html.escape(nick)}</span><span class="ow">담당 {html.escape(owner)}{meta_h}</span></div>
    {badge}
  </div>
  <div class="trend">{html.escape(disp_trend)}</div>
  {chart}
  <div class="stages">{stage_chips}</div>
</summary>
<div class="timeline">{tl}</div>
</details>\n'''
        cards_html += "</div>\n"

    legend = "".join(chip(t) for t in TAGS)
    today = datetime.date.today().strftime("%Y-%m-%d")
    if pub:
        kick="Growth Cases"; title="레슨생 성장 사례"
        sub='수강 종료 또는 목표 달성 레슨생의 코칭 여정을 공개합니다. 모든 코칭은 <b style="color:var(--gold)">주도권 → 우선순위 → 포지션 → 강제</b> 커리큘럼을 따릅니다.'
        note="※ 본인 동의 하에 공개된 닉네임 기반 성장 사례입니다. 더 많은 레슨생이 동일한 커리큘럼으로 코칭받고 있습니다."
        nse_label="공개 코칭 세션"; ns_label="공개 성장 사례"
    else:
        kick="Coaching Log · 내부 관리용"; title="레슨생 코칭 기록 (관리)"
        sub='전체 레슨생의 그날 수업 피드백·성장 동향 관리 화면입니다. <b style="color:var(--red)">대외 공개 링크 아님</b> — 공개 전환은 build_feedback.py의 PUBLIC에 추가.'
        note="※ 내부 관리용 전체 기록. 공개 페이지(lesson-feedback.html)에는 PUBLIC 지정 레슨생만 노출됩니다.<br>생성일 {{DATE}}"
        nse_label="누적 코칭 세션"; ns_label="관리 중 레슨생"
    return (TEMPLATE.replace("{{CARDS}}",cards_html).replace("{{LEGEND}}",legend)
        .replace("{{NS}}",str(total_students)).replace("{{NSE}}",str(total_sessions))
        .replace("{{DATE}}",today).replace("{{KICK}}",kick).replace("{{TITLE}}",title)
        .replace("{{SUB}}",sub).replace("{{NOTE}}",note)
        .replace("{{NSLABEL}}",ns_label).replace("{{NSELABEL}}",nse_label))

TEMPLATE = r'''<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>레슨생 코칭 기록 · MRI ACADEMY</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap" rel="stylesheet">
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
<style>
:root{--bg:#0a0a0c;--bg-card:#1a1a20;--ink:#f4f4f5;--ink-dim:#a1a1aa;--ink-faint:#71717a;--gold:#f5c518;--gold-soft:rgba(245,197,24,.3);--golddeep:#caa00f;--green:#10b981;--blue:#5ac8fa;--purple:#a855f7;--red:#e63946;--line:#27272a;--display:'Archivo Black',sans-serif;--body:'Pretendard Variable',sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.6;background-image:radial-gradient(circle at 50% 0,rgba(245,197,24,.06),transparent 60%),linear-gradient(rgba(245,197,24,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(245,197,24,.022) 1px,transparent 1px);background-size:auto,37px 37px,37px 37px}
.wrap{max-width:760px;margin:0 auto;padding:30px 18px 70px}
.top{text-align:center;margin-bottom:8px}
.kick{color:var(--gold);font-weight:800;font-size:12px;letter-spacing:.16em;text-transform:uppercase}
h1{font-family:var(--display);font-size:clamp(24px,6vw,34px);margin:8px 0 6px}
.sub{color:var(--ink-dim);font-size:14px}
.bar{display:flex;gap:10px;justify-content:center;margin:20px 0 8px;flex-wrap:wrap}
.stat{background:var(--bg-card);border:1px solid var(--line);border-radius:10px;padding:12px 20px;text-align:center}
.stat b{font-family:var(--display);font-size:22px;color:var(--gold);display:block}
.stat span{font-size:11px;color:var(--ink-faint)}
.legend{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin:16px 0 26px;padding:14px;background:var(--bg-card);border:1px solid var(--line);border-radius:10px}
.legend .lt{width:100%;text-align:center;font-size:11px;color:var(--ink-faint);margin-bottom:4px}
.tg{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:99px;white-space:nowrap;border:1px solid}
.tg.gold{color:var(--gold);border-color:var(--gold-soft);background:rgba(245,197,24,.08)}
.tg.blue{color:var(--blue);border-color:rgba(90,200,250,.3);background:rgba(90,200,250,.08)}
.tg.purple{color:var(--purple);border-color:rgba(168,85,247,.3);background:rgba(168,85,247,.08)}
.tg.red{color:var(--red);border-color:rgba(230,57,70,.3);background:rgba(230,57,70,.08)}
.tg.green{color:var(--green);border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.08)}
.tg.golddeep{color:var(--golddeep);border-color:var(--gold-soft);background:rgba(245,197,24,.06)}
.tg.faint{color:var(--ink-faint);border-color:var(--line);background:transparent}
.grp-title{font-family:var(--display);font-size:16px;margin:26px 0 12px;display:flex;align-items:center;gap:10px}
.grp-title span{font-family:var(--body);font-size:12px;font-weight:700;color:var(--gold);background:rgba(245,197,24,.08);border:1px solid var(--gold-soft);padding:2px 9px;border-radius:99px}
.cards{display:flex;flex-direction:column;gap:10px}
.sc{background:var(--bg-card);border:1px solid var(--line);border-radius:12px;overflow:hidden;transition:border-color .2s}
.sc[open]{border-color:var(--gold-soft)}
.sc summary{list-style:none;cursor:pointer;padding:15px 17px}
.sc summary::-webkit-details-marker{display:none}
.hd{display:flex;align-items:center;justify-content:space-between;gap:10px}
.nk{font-family:var(--display);font-size:16px;margin-right:9px}
.ow{font-size:11.5px;color:var(--ink-faint)}
.cnt{font-size:11px;font-weight:800;color:var(--gold);background:rgba(245,197,24,.08);border:1px solid var(--gold-soft);padding:3px 10px;border-radius:99px;flex-shrink:0}
.cnt.pubb{color:var(--green);background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.35)}
.trend{font-size:12.5px;color:var(--ink-dim);margin-top:8px}
.stages{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
.timeline{border-top:1px solid var(--line);padding:6px 17px 14px}
.sess{display:flex;gap:13px;padding:12px 0;border-bottom:1px solid rgba(39,39,42,.6)}
.sess:last-child{border-bottom:none}
.sd{font-family:var(--display);font-size:12px;color:var(--gold);min-width:42px;padding-top:2px}
.sb{flex:1}
.sb ul{margin:8px 0 0;padding-left:17px}
.sb li{font-size:13px;color:var(--ink-dim);margin-bottom:3px}
.sb .tg{margin:0 4px 4px 0;display:inline-block}
.note{margin-top:28px;font-size:12px;color:var(--ink-faint);text-align:center;line-height:1.7}
.back{display:inline-block;margin-top:22px;color:var(--gold);text-decoration:none;font-weight:700;font-size:14px}
.dchart{margin:10px 0 6px;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px}
.dctop{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
.dctitle{font-size:10.5px;color:var(--ink-faint);letter-spacing:.04em}
.dcdelta{font-size:13px;font-weight:800}
.dcsvg{width:100%;height:auto;display:block;max-width:320px;margin:0 auto}
.dctier{display:flex;align-items:center;gap:8px;justify-content:center;margin-top:2px;font-size:11.5px;font-weight:800}
.tarr{color:var(--ink-faint);font-weight:400}
.dcph{margin:10px 0 6px;padding:9px 12px;background:var(--bg);border:1px dashed var(--line);border-radius:8px;font-size:10.5px;color:var(--ink-faint);text-align:center}
</style></head>
<body>
<div class="wrap">
  <div class="top">
    <div class="kick">{{KICK}}</div>
    <h1>{{TITLE}}</h1>
    <p class="sub">{{SUB}}</p>
  </div>
  <div class="bar">
    <div class="stat"><b>{{NS}}</b><span>{{NSLABEL}}</span></div>
    <div class="stat"><b>{{NSE}}</b><span>{{NSELABEL}}</span></div>
    <div class="stat"><b>4단계</b><span>체계 커리큘럼</span></div>
  </div>
  <div class="legend"><div class="lt">커리큘럼 단계 태그</div>{{LEGEND}}</div>
  {{CARDS}}
  <p class="note">{{NOTE}}</p>
  <div style="text-align:center"><a class="back" href="index.html">← MRI ACADEMY 홈으로</a></div>
</div>
</body></html>'''

if __name__ == "__main__":
    pubhtml = render("public")
    with open("lesson-feedback.html","w",encoding="utf-8") as f:
        f.write(pubhtml)
    print("lesson-feedback.html (공개) 생성:", len(pubhtml), "bytes /", len(PUBLIC), "명")
    adminhtml = render("admin")
    with open("lesson-feedback-admin.html","w",encoding="utf-8") as f:
        f.write(adminhtml)
    print("lesson-feedback-admin.html (관리) 생성:", len(adminhtml), "bytes /", len(STUDENTS), "명")
