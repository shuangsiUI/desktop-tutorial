import {
  decimal,
  add,
  multiply,
  divide,
  maximum,
  ceiling,
  round,
  numeric
} from './backend/modules/commercial/arithmetic.mjs';
export function required(v, label) {
  if (typeof v !== 'string' || !v.trim() || v.length > 200)
    throw Error(label + '不能为空且最多200字');
  return v.trim();
}
export function num(v, label, min = 0, max = 1e8) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max)
    throw Error(label + '超出允许范围');
  return n;
}
export function quote(channel, boxes, { maxBoxes = 100 } = {}) {
  if (!Array.isArray(boxes) || !boxes.length || boxes.length > maxBoxes)
    throw Error('须填写1至' + maxBoxes + '箱');
  let weightExact = decimal(0),
    volumeExact = decimal(0),
    units = 0;
  const clean = boxes.map((b) => {
    const x = {
      sku: required(b.sku, 'SKU'),
      qty: num(b.qty, '数量', 1, 100000),
      weight: num(b.weight, '重量kg', 0.001, 10000),
      length: num(b.length, '长cm', 0.1, 1000),
      width: num(b.width, '宽cm', 0.1, 1000),
      height: num(b.height, '高cm', 0.1, 1000)
    };
    if (!Number.isInteger(x.qty)) throw Error('数量须为整数');
    weightExact = add(weightExact, decimal(x.weight));
    volumeExact = add(
      volumeExact,
      multiply(multiply(decimal(x.length), decimal(x.width)), decimal(x.height))
    );
    units += x.qty;
    return x;
  });
  const volumetricExact = divide(volumeExact, decimal(channel.divisor)),
    billableExact = multiply(
      {
        n: ceiling(
          divide(
            maximum(maximum(weightExact, volumetricExact), decimal(channel.minimum)),
            decimal(channel.step)
          )
        ),
        d: 1n
      },
      decimal(channel.step)
    );
  if (
    !Number.isSafeInteger(channel.rateCents) ||
    channel.rateCents < 0 ||
    !Number.isSafeInteger(channel.fixedCents) ||
    channel.fixedCents < 0
  )
    throw Error('费率须为整数分');
  const cents =
    round(multiply(billableExact, decimal(channel.rateCents))) + BigInt(channel.fixedCents);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('计费金额超限');
  return {
    boxes: clean,
    weight: numeric(weightExact),
    volume: numeric(divide(volumeExact, decimal(1e6))),
    volumetric: numeric(volumetricExact),
    billable: numeric(billableExact),
    units,
    estimatedCents: Number(cents)
  };
}
export const transitions = {
  draft: ['booked', 'cancelled'],
  booked: ['transit', 'cancelled'],
  transit: ['delivered', 'exception'],
  exception: ['transit', 'delivered'],
  delivered: [],
  cancelled: []
};
export function transition(order, status, tracking) {
  if (!transitions[order.status]?.includes(status)) throw Error('不允许的状态流转');
  if (status === 'booked') required(tracking, '运单号');
  return status;
}
