const form = document.querySelector("[data-recording-form]");
const result = document.querySelector("[data-recommendation]");
const failure = document.querySelector("#recording-error");
const recommend = form.querySelector("[data-recommend]");
const reserve = result.querySelector("[data-reserve]");
const availability = result.querySelector("[data-rec-availability]");
const key = form.elements.key;
let loaded = false;

async function call(path, payload) {
  const res = await fetch(`/api/demo/recording/${path}`, payload ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  } : { cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw Object.assign(new Error(data?.error || "The recording flow is unavailable. Try again."), { status: res.status });
  }
  return data;
}

function choice(name, { id, name: title }) {
  const label = document.createElement("label");
  label.className = "opt";
  label.innerHTML = '<input type="radio" required><span class="opt__body"><strong></strong></span>';
  const input = label.firstElementChild;
  input.name = name;
  input.value = id;
  label.querySelector("strong").textContent = title;
  return label;
}

export async function loadRecording() {
  if (loaded) return;
  const catalog = await call("catalog");
  form.querySelector("[data-recording-profiles]").replaceChildren(...catalog.profiles.map((p) => choice("profile", p)));
  form.querySelector("[data-recording-users]").replaceChildren(...catalog.users.map((option) => choice("users", option)));
  loaded = true;
}

export function bindRecording(resumed) {
  let busy = false, canReserve = false;

  function lock(next) {
    busy = next;
    recommend.disabled = busy;
    reserve.disabled = busy || !canReserve;
    for (const fields of form.querySelectorAll("fieldset")) fields.disabled = busy;
  }

  function clearError() {
    failure.hidden = true;
    key.removeAttribute("aria-invalid");
  }

  form.addEventListener("input", () => {
    clearError();
    canReserve = false;
    result.hidden = true;
    reserve.disabled = true;
  });

  async function submit(path) {
    clearError();
    const payload = Object.fromEntries(new FormData(form));
    lock(true);
    try {
      const data = await call(path, payload);
      if (path === "start") {
        key.value = "";
        result.hidden = true;
        await resumed();
        return;
      }
      result.querySelector("[data-rec-gpu]").textContent = data.recommendation.gpu;
      result.querySelector("[data-rec-model]").textContent = data.recommendation.model;
      availability.textContent = data.available ? "Matching offer available" : "No matching offer is available.";
      availability.classList.toggle("is-unavailable", !data.available);
      canReserve = data.available;
      result.hidden = false;
      result.querySelector("h2").focus();
    } catch (error) {
      failure.textContent = error.message;
      failure.hidden = false;
      if (error.status === 401) {
        key.setAttribute("aria-invalid", "true");
      }
      if (error.status === 409) {
        canReserve = false;
        availability.textContent = error.message;
        availability.classList.add("is-unavailable");
      }
    } finally {
      lock(false);
      if (key.hasAttribute("aria-invalid")) key.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!busy) submit("recommendation");
  });
  reserve.addEventListener("click", () => {
    if (canReserve && !busy) submit("start");
  });
}
