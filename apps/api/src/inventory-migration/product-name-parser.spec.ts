import {
  parseProductName,
  mergeParsedProductNames,
  medicineEntryToParsed,
  type ParsedProductName,
  type MedicineEntry,
} from './product-name-parser';

describe('parseProductName', () => {
  it('parses a «»-separated single-ingredient name to HIGH confidence with a canonical concentration match', () => {
    const result = parseProductName('Amoxicilina  250mg (Susp Oral) «» VANDIX SUSP. 75 ML. 250 MG');
    expect(result.confidence).toBe('HIGH');
    expect(result.ingredients).toEqual([{ name: 'amoxicilina', concentrationValue: 250, concentrationUnit: 'mg/5 ml', order: 0 }]);
    expect(result.form).toBe('SUSPENSION');
    expect(result.route).toBe('ORAL');
    expect(result.category).toBe('Antibióticos');
  });

  it('parses a non-«» name using abbreviated form/concentration text', () => {
    const result = parseProductName('Ac Acetilsalicilico 100mg 30 Tab Aspitak-p');
    expect(result.ingredients[0]?.name).toBe('ácido acetilsalicílico');
    expect(result.ingredients[0]?.concentrationValue).toBe(100);
    expect(result.ingredients[0]?.concentrationUnit).toBe('mg');
    expect(result.form).toBe('TABLET');
    expect(result.route).toBe('ORAL');
  });

  it('builds presentation as form + concentration — packaging c/count, not envase + concentration', () => {
    const result = parseProductName('Albendazol 200mg (Tabs) «» VERMISEN c/6 TABS 200 MG');
    expect(result.presentation).toBe('Tableta 200mg — Caja c/6 tabletas');
  });

  it('splits a combo-ratio concentration across ingredients positionally', () => {
    const result = parseProductName('Amoxicilina ac Clavulánico 500/125 mg (Tabs) «» CLAVULIN c/20 TABS. 500/125 MG');
    expect(result.ingredients).toEqual([
      { name: 'amoxicilina', concentrationValue: 500, concentrationUnit: 'mg', order: 0 },
      { name: 'ácido clavulánico', concentrationValue: 125, concentrationUnit: 'mg', order: 1 },
    ]);
    expect(result.confidence).toBe('HIGH');
  });

  it('matches a canonical combo dose whether the raw name repeats the unit per segment or not', () => {
    const perSegment = parseProductName('Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta');
    expect(perSegment.confidence).toBe('HIGH');
    expect(perSegment.ingredients).toEqual([
      { name: 'amoxicilina', concentrationValue: 500, concentrationUnit: 'mg', order: 0 },
      { name: 'ácido clavulánico', concentrationValue: 125, concentrationUnit: 'mg', order: 1 },
    ]);
  });

  it('does not fabricate a compound match for an ingredient pair the dataset never pairs', () => {
    const result = parseProductName('Cetirizina/Ácido Clavulánico 500mg/10mg Tableta');
    expect(result.ingredients).toEqual([{ name: 'cetirizina', concentrationValue: null, concentrationUnit: null, order: 0 }]);
    expect(result.confidence).toBe('MEDIUM');
  });

  it('downgrades to MEDIUM confidence when the extracted concentration is not a canonical value', () => {
    const result = parseProductName('Paracetamol 999mg tabs');
    expect(result.ingredients[0]?.name).toBe('paracetamol');
    expect(result.ingredients[0]?.concentrationValue).toBeNull();
    expect(result.confidence).toBe('MEDIUM');
  });

  it('returns LOW confidence with no ingredients for a non-pharma retail name', () => {
    const result = parseProductName('Bimbo Panque Nuez Bolsa 255G');
    expect(result.confidence).toBe('LOW');
    expect(result.ingredients).toEqual([]);
    expect(result.form).toBeNull();
  });

  it('never falls back to the structural OCR-layout guess for a single-line (non-OCR) name', () => {
    const result = parseProductName('Puribel 300 Alopurinol Tableta 300mg Caja con 20 Tabletas');
    expect(result).toEqual({
      ingredients: [],
      form: null,
      route: null,
      routeOptions: [],
      formOptions: [],
      concentrationOptions: [],
      presentation: null,
      brand: null,
      category: null,
      confidence: 'LOW',
    });
  });

  it('structurally guesses an unlisted single-ingredient drug from multi-line OCR text, anchored on the form line', () => {
    const result = parseProductName('Puribel 300\nAlopurinol\nTableta\n300mg\nCaja con 20 Tabletas');
    expect(result.confidence).toBe('LOW');
    expect(result.ingredients).toEqual([{ name: 'Alopurinol', concentrationValue: 300, concentrationUnit: 'mg', order: 0 }]);
    expect(result.form).toBe('TABLET');
    expect(result.presentation).toBe('Caja con 20 Tabletas');
    expect(result.brand).toBe('Puribel 300');
  });

  it('structurally guesses an unlisted combo ingredient from multi-line OCR text, splitting the shared-unit concentration, and reads brand + presentación verbatim off their own lines', () => {
    const result = parseProductName(
      'Perludil\nAlgestona / Estradiol\n150 mg/10 mg\nSolución inyectable\nCaja con 1 ampolleta con 1 ml',
    );
    expect(result.confidence).toBe('LOW');
    expect(result.ingredients).toEqual([
      { name: 'Algestona', concentrationValue: 150, concentrationUnit: 'mg', order: 0 },
      { name: 'Estradiol', concentrationValue: 10, concentrationUnit: 'mg', order: 1 },
    ]);
    expect(result.form).toBe('INJECTION');
    expect(result.brand).toBe('Perludil');
    expect(result.presentation).toBe('Caja con 1 ampolleta con 1 ml');
  });

  it('reads a plain (non-injectable) "Solución" line as the SOLUTION form, distinct from OTHER', () => {
    const result = parseProductName('Marca Ficticia\nZzyxilina\nSolución\nFrasco 120ml');
    expect(result.form).toBe('SOLUTION');
  });

  it('trusts the raw form/concentration at MEDIUM confidence for a real, matched ingredient whose dataset entry just does not list that form', () => {
    // ambroxol's dataset entry only lists jarabe/tableta/gotas presentaciones
    // — no solución — so there's nothing to validate this specific form/dose
    // against, but the ingredient match itself is real.
    const result = parseProductName('Ambroxol Solución 300 mg/100 mL');
    expect(result.ingredients).toEqual([{ name: 'ambroxol', concentrationValue: 300, concentrationUnit: 'mg/100 mL', order: 0 }]);
    expect(result.form).toBe('SOLUTION');
    expect(result.route).toBe('ORAL');
    expect(result.confidence).toBe('MEDIUM');
  });

  it('structurally guesses a 3-way combo separated by commas (not slashes), not just the one segment that happens to be a real dataset ingredient', () => {
    // clorfenamina alone is a real dataset entry — without the "does the
    // dataset match cover every guessed name" check, findIngredientInText
    // would grab just that one and silently drop amantadina/paracetamol.
    const result = parseProductName('Amantadina, Clorfenamina, Paracetamol\nCápsula\n50 mg/3 mg/300 mg');
    expect(result.confidence).toBe('LOW');
    expect(result.ingredients).toEqual([
      { name: 'Amantadina', concentrationValue: 50, concentrationUnit: 'mg', order: 0 },
      { name: 'Clorfenamina', concentrationValue: 3, concentrationUnit: 'mg', order: 1 },
      { name: 'Paracetamol', concentrationValue: 300, concentrationUnit: 'mg', order: 2 },
    ]);
    expect(result.form).toBe('CAPSULE');
  });

  it('anchors on the real form/concentration declaration, not an earlier unrelated occurrence of a form word in marketing copy or a brand tagline, and reads an explicit "Vía de administración" line', () => {
    // "Roselt Tabletas con ..." (a brand tagline) contains "Tabletas" before
    // the real "Tableta" / "50 mg/3 mg/300 mg" declaration further down —
    // anchoring on the first occurrence would land on "Roselt" as the
    // ingredient candidate instead. "Caja15" (a shelf/price tag before the
    // ingredient block) and the marketing copy after the dose line
    // ("Furacin", "Alliviax", ...) are noise that should be ignored, not
    // mistaken for packaging or ingredients.
    const ocr = [
      '(w)', 'Caja15', 'WERMAR*', 'Roselt', 'Tabletas', 'con',
      'Amantadina, Clorfenamina, Paracetamol', 'Tableta', '50 mg/3 mg/300 mg',
      'Via de administración: Oral', 'Antigripal con', 'Auxiliar en el tratamiento',
      'ACCIÓN ANTIVIRAL', 'de la gripe', 'específica', 'Furacin', 'Alliviax', 'oas€', 'Furacin', 'FLEXTRIN',
    ].join('\n');
    const result = parseProductName(ocr);
    expect(result.ingredients).toEqual([
      { name: 'Amantadina', concentrationValue: 50, concentrationUnit: 'mg', order: 0 },
      { name: 'Clorfenamina', concentrationValue: 3, concentrationUnit: 'mg', order: 1 },
      { name: 'Paracetamol', concentrationValue: 300, concentrationUnit: 'mg', order: 2 },
    ]);
    expect(result.form).toBe('TABLET');
    expect(result.route).toBe('ORAL');
    expect(result.presentation).toBeNull();
    expect(result.brand).toBeNull();
  });

  it('rejects a structural guess candidate line that looks like packaging text, not an ingredient name', () => {
    const result = parseProductName('Algo Raro\nCaja con 10\nTableta');
    expect(result.confidence).toBe('LOW');
    expect(result.ingredients).toEqual([]);
  });
});

describe('mergeParsedProductNames', () => {
  const empty = (overrides: Partial<ParsedProductName> = {}): ParsedProductName => ({
    ingredients: [],
    form: null,
    route: null,
    routeOptions: [],
    formOptions: [],
    concentrationOptions: [],
    presentation: null,
    brand: null,
    category: null,
    confidence: 'LOW',
    ...overrides,
  });

  it('lets whichever side has ingredients win outright there, ignoring the other side entirely for ingredients/confidence', () => {
    const withIngredients = empty({
      ingredients: [{ name: 'paracetamol', concentrationValue: 500, concentrationUnit: 'mg', order: 0 }],
      confidence: 'HIGH',
    });
    const withoutIngredients = empty({ confidence: 'LOW' });
    expect(mergeParsedProductNames(withIngredients, withoutIngredients).ingredients).toEqual(withIngredients.ingredients);
    expect(mergeParsedProductNames(withoutIngredients, withIngredients).ingredients).toEqual(withIngredients.ingredients);
    expect(mergeParsedProductNames(withoutIngredients, withIngredients).confidence).toBe('HIGH');
  });

  it('falls back to the other side for any field the winner left blank, instead of discarding it', () => {
    const ocrParse = empty({
      ingredients: [{ name: 'amoxicilina', concentrationValue: 500, concentrationUnit: 'mg', order: 0 }],
      form: 'TABLET',
      confidence: 'MEDIUM',
      // no brand — OCR text had no «» marker
    });
    const nameParse = empty({
      // no ingredients at all — Square name alone didn't resolve
      brand: 'CLAVULIN',
      route: 'ORAL',
    });
    const merged = mergeParsedProductNames(ocrParse, nameParse);
    expect(merged.ingredients).toEqual(ocrParse.ingredients);
    expect(merged.form).toBe('TABLET');
    expect(merged.brand).toBe('CLAVULIN');
    expect(merged.route).toBe('ORAL');
  });

  it('breaks a tie (both sides have ingredients) with the higher confidence tier, still filling gaps from the loser', () => {
    const lowConfidence = empty({
      ingredients: [{ name: 'ibuprofeno', concentrationValue: null, concentrationUnit: null, order: 0 }],
      confidence: 'LOW',
      presentation: 'Caja con 10 tabletas',
    });
    const highConfidence = empty({
      ingredients: [{ name: 'ibuprofeno', concentrationValue: 400, concentrationUnit: 'mg', order: 0 }],
      confidence: 'HIGH',
      // no presentation
    });
    const merged = mergeParsedProductNames(lowConfidence, highConfidence);
    expect(merged.ingredients).toEqual(highConfidence.ingredients);
    expect(merged.confidence).toBe('HIGH');
    expect(merged.presentation).toBe('Caja con 10 tabletas');
  });
});

describe('medicineEntryToParsed', () => {
  const base: MedicineEntry = {
    name: 'Metformina/Glibenclamida 500/5 mg «» GLUCOVANCE c/40 TABS',
    esMedicamento: true,
    principios_activos: [
      { nombre: 'Metformina', dosis: '500 mg', strength: { valor: 500, unidad: 'mg', por: null } },
      { nombre: 'Glibenclamida', dosis: '5.0 mg', strength: { valor: 5, unidad: 'mg', por: null } },
    ],
    formaFarmaceutica: 'Tableta',
    presentacion: 'Caja con 40 tabletas',
    marca: 'Glucovance',
    laboratorio: 'Merck',
  };

  it('maps each broken-down ingredient to its own value + unit', () => {
    const parsed = medicineEntryToParsed(base);
    expect(parsed.brand).toBe('Glucovance');
    expect(parsed.form).toBe('TABLET');
    expect(parsed.route).toBe('ORAL');
    expect(parsed.confidence).toBe('HIGH');
    expect(parsed.presentation).toBe('Caja con 40 tabletas');
    expect(parsed.ingredients).toEqual([
      { name: 'Metformina', concentrationValue: 500, concentrationUnit: 'mg', order: 0 },
      { name: 'Glibenclamida', concentrationValue: 5, concentrationUnit: 'mg', order: 1 },
    ]);
  });

  it('renders a per-volume strength as "<unidad>/<por>"', () => {
    const parsed = medicineEntryToParsed({
      ...base,
      principios_activos: [{ nombre: 'Amoxicilina', dosis: '250 mg/5 mL', strength: { valor: 250, unidad: 'mg', por: '5 mL' } }],
      formaFarmaceutica: 'Suspensión Oral',
    });
    expect(parsed.ingredients).toEqual([
      { name: 'Amoxicilina', concentrationValue: 250, concentrationUnit: 'mg/5 mL', order: 0 },
    ]);
    expect(parsed.route).toBe('ORAL');
  });

  it('falls back to parsing dosis when strength.valor is null', () => {
    const parsed = medicineEntryToParsed({
      ...base,
      principios_activos: [{ nombre: 'Paracetamol', dosis: '300 mg', strength: { valor: null, unidad: null, por: null } }],
    });
    expect(parsed.ingredients[0]).toEqual({ name: 'Paracetamol', concentrationValue: 300, concentrationUnit: 'mg', order: 0 });
  });

  it('infers route from an explicit forma word', () => {
    const oft = medicineEntryToParsed({ ...base, formaFarmaceutica: 'Solución Oftálmica en Gotas' });
    expect(oft.route).toBe('OPHTHALMIC');
    const crema = medicineEntryToParsed({ ...base, formaFarmaceutica: 'Crema' });
    expect(crema.route).toBe('TOPICAL');
    const iny = medicineEntryToParsed({ ...base, formaFarmaceutica: 'Suspensión Inyectable' });
    expect(iny.route).toBe('INJECTABLE');
  });

  it('leaves ingredients empty when principios_activos is empty', () => {
    const parsed = medicineEntryToParsed({ ...base, principios_activos: [] });
    expect(parsed.ingredients).toEqual([]);
    expect(parsed.brand).toBe('Glucovance');
  });
});
