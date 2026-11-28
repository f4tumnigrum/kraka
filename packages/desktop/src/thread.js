const params = new URLSearchParams(location.search);
window.desktop
  .connectRoute({ environmentId: params.get("environmentId"), routeId: params.get("routeId") })
  .then((result) => {
    if (result === "unavailable")
      document.querySelector("output").textContent = "Environment unavailable";
  });
