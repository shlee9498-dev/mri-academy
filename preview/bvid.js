// ============================================================
// B안 생성 영상 2개(첫 화면 배경 · 레슨 구간). 파일이 있을 때만 켜진다.
// - 영상이 실제로 재생되면 3D 장면을 끈다(자기장을 두 번 그리지 않게)
// - 반복 이음매는 끝 0.5초를 어둡게 페이드해서 가린다
// - 저사양 · 움직임 줄이기면 재생하지 않고 포스터만 보인다
// ============================================================
(function () {
  var lite = !!window.MRI_LITE;

  function arm(video, onReady) {
    var src = video.getAttribute("data-src"), poster = video.getAttribute("data-poster");
    if (lite) {
      // 포스터만: 이미지가 실제로 있을 때만 붙인다
      var im = new Image();
      im.onload = function () { video.poster = poster; onReady(false); };
      im.src = poster;
      return;
    }
    video.addEventListener("loadeddata", function () { onReady(true); }, { once: true });
    video.addEventListener("timeupdate", function () {
      var d = video.duration;
      if (!d) return;
      var end = d - video.currentTime < 0.55, start = video.currentTime < 0.45;
      video.classList.toggle("dim", end || start);
    });
    video.poster = poster;
    video.src = src;
    video.load();
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  // 첫 화면 배경
  var hero = document.querySelector(".hero");
  var hv = document.querySelector(".hero-vid video");
  if (hero && hv) {
    arm(hv, function () { hero.classList.add("hasvid"); });
  }

  // 레슨 구간: 화면 가까이 왔을 때 불러온다. 마지막 3초(연막만 남는 구간)에 글자를 올린다
  var fig = document.querySelector("figure.smoke");
  if (fig) {
    var sv = fig.querySelector("video");
    var go = function () {
      arm(sv, function (playing) {
        fig.hidden = false;
        if (!playing) fig.classList.add("cap");
      });
      if (!lite) sv.addEventListener("timeupdate", function () {
        fig.classList.toggle("cap", sv.duration && sv.duration - sv.currentTime < 3.2);
      });
    };
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) { io.disconnect(); go(); }
      }, { rootMargin: "400px 0px" });
      io.observe(document.getElementById("trainers") || fig);
    } else go();
  }
})();
