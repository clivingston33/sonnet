// The star count beside the GitHub mark. Without an answer (offline, rate limit) the mark stands alone.
fetch("https://api.github.com/repos/clivingston33/sonnet")
  .then((res) => res.json())
  .then(({ stargazers_count: stars }) => {
    if (!Number.isFinite(stars)) return;
    for (const el of document.querySelectorAll("[data-stars]")) el.textContent = stars.toLocaleString("en");
  })
  .catch(() => {});
