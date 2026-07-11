const target = './feature-a';

export async function loadAmbiguous() {
  return import(target);
}
