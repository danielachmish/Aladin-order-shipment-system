// שיתוף מרוכז ללקוח על כל השורות החלקיות/חסרות בהזמנה — תמונה אחת עם כל
// הפריטים ביחד, במקום שיתוף נפרד לכל שורה. ר' PICKING_QC_SPEC.md (עודכן 14.9.2026).
export async function shareShortageSummary(order, shortageItems) {
  const rowHeight = 70;
  const headerHeight = 130;
  const width = 640;
  const height = headerHeight + shortageItems.length * rowHeight + 30;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#F3F7FA';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#0B5C66';
  ctx.fillRect(0, 0, width, 64);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'right';
  ctx.font = 'bold 26px Arial, sans-serif';
  ctx.fillText('אלדין', width - 40, 42);

  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 18px Arial, sans-serif';
  ctx.fillText(`הזמנה ${order.order_num} — פריטים שהתעדכנו`, width - 40, 100);
  ctx.fillStyle = '#6b7280';
  ctx.font = '14px Arial, sans-serif';
  ctx.fillText(order.customer_name || '', width - 40, 122);

  let y = headerHeight;
  for (const item of shortageItems) {
    const isMissing = item.pick_status === 'missing';
    ctx.fillStyle = '#fff';
    ctx.fillRect(30, y, width - 60, rowHeight - 10);
    ctx.strokeStyle = isMissing ? '#c0392b' : '#c2760a';
    ctx.lineWidth = 2;
    ctx.strokeRect(30, y, width - 60, rowHeight - 10);

    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 17px Arial, sans-serif';
    ctx.fillText(item.item_name, width - 45, y + 26);
    ctx.font = '13px Arial, sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`מק"ט: ${item.item_code}`, width - 45, y + 44);

    ctx.font = 'bold 15px Arial, sans-serif';
    ctx.fillStyle = isMissing ? '#c0392b' : '#c2760a';
    const label = isMissing
      ? `חסר במלאי (הוזמנו ${item.quantity})`
      : `יש ${item.qty_picked} מתוך ${item.quantity}`;
    ctx.textAlign = 'left';
    ctx.fillText(label, 45, y + 35);
    ctx.textAlign = 'right';

    y += rowHeight;
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], `hoser-${order.order_num}.png`, { type: 'image/png' });
  // נוסח עודכן 14.9.2026 (בקשת דניאל) — עדין ומתנצל, נשלח ללקוח מייד אחרי הליקוט
  const text = `שלום, מדברים ממחסן אלדין 🙏\nבהזמנה מספר ${order.order_num} התגלו ${shortageItems.length} פריטים עם חוסר/כמות חלקית (פירוט מצורף).\nמתנצלים על אי הנוחות — נעדכן אתכם ברגע שהם יחזרו למלאי.`;

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `הזמנה ${order.order_num}`, text });
      return;
    } catch {
      // המשתמש ביטל את השיתוף — לא שגיאה, פשוט לא עושים כלום
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}
