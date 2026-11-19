// Picker catalog used by the Worker and the local rehearsal.
export const PROFILES = [
  { id: "threadripper", name: "Threadripper PRO 9995WX", ramGb: 256 },
  { id: "epyc", name: "AMD EPYC 9004 / 9005", ramGb: 256 },
  { id: "epyc-7742", name: "AMD EPYC 7742", ramGb: 344 },
];
export const RECORDING_MODELS = [
  { id: "fast", label: "Qwen3.8-27B" },
  { id: "deep", label: "Qwen3.8-Flash-Next" },
];
export const RECORDING_SETUPS = [
  { id: "1", sizingUsers: 1, gpuCount: 1, gpu: "1× RTX 3090", model: "Qwen3.8-Flash-Next" },
  { id: "8", sizingUsers: 4, gpuCount: 2, gpu: "2× RTX 3090", model: "Qwen3.8-Flash-Next + Qwen3.8-27B" },
];
export function setupForUsers(users) {
  if (typeof users === "string" || typeof users === "number") {
    return RECORDING_SETUPS.find(({ id }) => id === String(users));
  }
}
export const recordingModels = (users) => setupForUsers(users)?.gpuCount === 2 ? RECORDING_MODELS : [];

// Size each range at its upper end, assuming 10% of all users are active together.
const USERS_PER_ACTIVE_USER = 10;
export const userOptions = RECORDING_SETUPS.map(({ id, sizingUsers }, index) => {
  const previous = RECORDING_SETUPS[index - 1]?.sizingUsers ?? 0;
  const min = previous * USERS_PER_ACTIVE_USER + 1;
  const max = sizingUsers * USERS_PER_ACTIVE_USER;
  return { id, name: `${min}–${max} users` };
});
