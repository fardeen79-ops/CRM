// Credit cards staff can choose from when a case includes the Credit Card product.
// Grouped by card family; edit this list to add or retire cards.
export const CREDIT_CARDS = [
  { family: 'Core (Platinum/Titanium/Infinite)', cards: ['Infinite Credit Card', 'MasterCard Platinum Credit Card', 'Titanium Credit Card'] },
  { family: 'Darna', cards: ['Darna Select Visa Credit Card', 'Darna Visa Infinite Credit Card', 'Darna Visa Signature Credit Card'] },
  { family: 'Duo Card', cards: ['Diners Club Credit Card'] },
  { family: 'Etihad Guest', cards: ['Etihad Guest Visa Elevate Credit Card', 'Etihad Guest Visa Inspire Credit Card'] },
  { family: 'LuLu', cards: ['LuLu Platinum Mastercard Credit Card', 'LuLu Titanium Mastercard Credit Card'] },
  { family: 'Marriott Bonvoy', cards: ['Marriott Bonvoy World Elite Mastercard Credit Card', 'Marriott Bonvoy World Mastercard Credit Card'] },
  { family: 'Priority Banking', cards: ['PRIORITY BANKING VISA INFINITE CREDIT CARD'] },
  { family: 'Share', cards: ['Share Visa Infinite Credit Card', 'Share Visa Platinum Credit Card', 'Share Visa Signature Credit Card'] },
  { family: 'Skywards', cards: ['Skywards Infinite Credit Card', 'Skywards Signature Credit Card'] },
  { family: 'U By Emaar', cards: ['U By Emaar Family Credit Card', 'U By Emaar Infinite Credit Card', 'U By Emaar Signature Credit Card'] },
  { family: 'Visa Flexi', cards: ['Visa Flexi Credit card'] },
  { family: 'Voyager', cards: ['Voyager World', 'Voyager World Elite'] },
  { family: 'Webshopper', cards: ['Webshopper Credit Card'] },
  { family: 'dnata', cards: ['dnata Platinum Credit Card', 'dnata World Mastercard Credit Card'] },
  { family: 'noon', cards: ['noon One Visa Credit Card'] },
];

export const CREDIT_CARD_NAMES = new Set(CREDIT_CARDS.flatMap((f) => f.cards));
