export interface SelectChoice {
  index: number;
  value: string;
  label: string;
  group: string;
  disabled: boolean;
}

export function searchKey(text: string) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_-]/g, '');
}

export function matchingChoices(choices: SelectChoice[], query: string) {
  const terms = searchKey(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return choices;
  return choices.filter((choice) => {
    const text = searchKey(`${choice.label} ${choice.group}`);
    return terms.every((term) => text.includes(term));
  });
}

export function nextChoice(choices: SelectChoice[], current: number, direction: 1 | -1) {
  if (!choices.length) return -1;
  let index = current < 0 ? (direction === 1 ? -1 : 0) : current;
  for (let n = 0; n < choices.length; n++) {
    index = (index + direction + choices.length) % choices.length;
    if (!choices[index].disabled) return index;
  }
  return -1;
}
