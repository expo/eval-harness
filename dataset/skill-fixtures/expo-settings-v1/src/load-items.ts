export async function loadItems(url: string) {
  const response = await fetch(url);
  return response.json();
}
