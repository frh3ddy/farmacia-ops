/**
 * Seed the admin catalog taxonomy (Category -> Subcategory) used by the "Add Product" form.
 *
 * This is the manually-curated taxonomy for the Add Product screen. The
 * cutover extraction flow's classifier (category-classifier.ts) buckets
 * products by regex and maps every bucket onto one of these same categories
 * (see TARGET_CATEGORY there) — the extraction wizard's category picker and
 * the Add Product screen both read from this one taxonomy, never a separate
 * classifier-only list.
 *
 * Idempotent: find-or-create by (name, parentId), safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/seed-category-hierarchy.ts
 */
import prisma from '../prisma/client';

const TAXONOMY: Record<string, string[]> = {
  'Medicamentos': [
    'Analgésicos y antipiréticos', 'Antiinflamatorios', 'Antibióticos', 'Antigripales',
    'Antitusivos y expectorantes', 'Antialérgicos', 'Antiácidos y medicamentos gastrointestinales',
    'Antidiarreicos', 'Laxantes', 'Antiespasmódicos', 'Antieméticos', 'Medicamentos para diabetes',
    'Medicamentos para hipertensión', 'Medicamentos cardiovasculares', 'Medicamentos para colesterol',
    'Vitaminas y minerales', 'Medicamentos dermatológicos', 'Antifúngicos', 'Antivirales',
    'Antisépticos', 'Medicamentos oftálmicos', 'Medicamentos óticos', 'Medicamentos ginecológicos',
    'Medicamentos urológicos', 'Medicamentos pediátricos', 'Medicamentos para enfermedades respiratorias',
    'Medicamentos de venta libre (OTC)', 'Medicamentos de prescripción',
  ],
  'Material de curación': [
    'Gasas', 'Algodón', 'Vendas', 'Curitas', 'Esparadrapo', 'Micropore', 'Apósitos', 'Alcohol',
    'Agua oxigenada', 'Antisépticos', 'Soluciones para limpieza de heridas', 'Guantes', 'Jeringas',
    'Agujas', 'Bolsas para hielo/calor',
  ],
  'Dispositivos médicos': [
    'Baumanómetros', 'Estetoscopios', 'Glucómetros', 'Tiras reactivas', 'Oxímetros', 'Termómetros',
    'Nebulizadores', 'Básculas', 'Equipos para medir glucosa', 'Equipos de primeros auxilios',
  ],
  'Bebés y maternidad': [
    'Pañales', 'Toallitas húmedas', 'Fórmulas infantiles', 'Alimentos para bebé', 'Biberones',
    'Chupones', 'Accesorios para lactancia', 'Cremas para rozaduras', 'Shampoo y jabón para bebé',
    'Higiene nasal', 'Termómetros infantiles',
  ],
  'Higiene y cuidado personal': [
    'Shampoo', 'Acondicionador', 'Jabón corporal', 'Jabón íntimo', 'Desodorantes', 'Cremas corporales',
    'Cremas para manos', 'Talcos', 'Toallas húmedas', 'Toallas sanitarias', 'Protectores diarios',
    'Tampones', 'Rasuradoras', 'Productos para depilación', 'Cepillos de dientes', 'Pasta dental',
    'Hilo dental', 'Enjuague bucal',
  ],
  'Cuidado de la piel': [
    'Bloqueadores solares', 'Cremas hidratantes', 'Cremas para piel sensible', 'Tratamientos para acné',
    'Cremas antimicóticas', 'Cremas para irritaciones', 'Cremas para quemaduras', 'Productos antiedad',
    'Bálsamos labiales', 'Agua micelar', 'Limpiadores faciales',
  ],
  'Cuidado capilar': [
    'Shampoo', 'Acondicionadores', 'Tratamientos capilares', 'Anticaspa', 'Tintes', 'Gel y fijadores',
    'Productos contra caída del cabello', 'Cepillos y peines',
  ],
  'Vitaminas, suplementos y nutrición': [
    'Multivitamínicos', 'Vitamina C', 'Vitamina D', 'Complejo B', 'Calcio', 'Hierro', 'Magnesio',
    'Omega 3', 'Electrolitos', 'Bebidas de rehidratación', 'Suplementos nutricionales',
    'Productos para adultos mayores',
  ],
  'Cuidado bucal': [
    'Pastas dentales', 'Cepillos', 'Enjuagues', 'Hilo dental', 'Cepillos interdentales',
    'Prótesis dentales y adhesivos', 'Tratamientos para sensibilidad dental',
  ],
  'Salud sexual': [
    'Condones', 'Lubricantes', 'Pruebas de embarazo', 'Pruebas de ovulación', 'Anticonceptivos',
    'Productos de higiene íntima',
  ],
  'Adultos mayores': [
    'Pañales para adulto', 'Protectores', 'Bastones', 'Andaderas', 'Fajas', 'Medias de compresión',
    'Productos para movilidad', 'Suplementos nutricionales',
  ],
  'Ortopedia y rehabilitación': [
    'Rodilleras', 'Muñequeras', 'Tobilleras', 'Fajas', 'Cabestrillos', 'Collares cervicales',
    'Medias de compresión', 'Plantillas', 'Soportes ortopédicos',
  ],
  'Limpieza y desinfección': [
    'Gel antibacterial', 'Alcohol', 'Desinfectantes', 'Jabones antibacteriales',
    'Toallitas desinfectantes', 'Productos para higiene de manos',
  ],
  'Bebidas y productos de hidratación': [
    'Sueros orales', 'Bebidas con electrolitos', 'Agua', 'Bebidas nutricionales',
  ],
  'Productos diversos': [
    'Repelentes', 'Productos para picaduras', 'Bolsas térmicas', 'Accesorios de primeros auxilios',
    'Cubrebocas', 'Caretas', 'Pilas para dispositivos médicos',
  ],
};

async function ensureCategory(name: string, parentId: string | null): Promise<string> {
  const existing = await prisma.category.findFirst({ where: { name, parentId } });
  if (existing) return existing.id;
  const created = await prisma.category.create({ data: { name, parentId } });
  return created.id;
}

async function main() {
  let topLevel = 0;
  let sub = 0;

  for (const [parentName, children] of Object.entries(TAXONOMY)) {
    const parentId = await ensureCategory(parentName, null);
    topLevel++;
    for (const childName of children) {
      await ensureCategory(childName, parentId);
      sub++;
    }
  }

  console.log(`Seeded ${topLevel} top-level categories, ${sub} subcategories (idempotent — re-run anytime).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
