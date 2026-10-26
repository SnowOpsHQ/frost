/**
 * Structured data: the vocabulary frost checks it against (Phase 2 Task 3; acceptance:
 * `seo-schema.feature.md`). Plain values with no imports, so `@app/seo-core` and the chrome renderer
 * can both use them. The rules that apply these sets are in `seo-rules.spec.ts` (category `schema`);
 * the extraction caps are `SNAPSHOT_LIMITS` in `seo-limits.spec.ts`.
 *
 * Clean-room: every set and threshold here is frost's own, derived from the schema.org type
 * definitions (what a type means and which of its properties identify it) and from general practice
 * for search features built on structured data (a product needs something to buy or a rating, an
 * event needs a time and a place). The wording and the selection are frost's.
 */

/** The three syntaxes frost reads, in the order the Schema panel lists them. */
export const SCHEMA_SYNTAXES = ['json-ld', 'microdata', 'rdfa'] as const;
export type SchemaSyntax = (typeof SCHEMA_SYNTAXES)[number];
export const SCHEMA_SYNTAX_LABELS: Readonly<Record<SchemaSyntax, string>> = { 'json-ld': 'JSON-LD', microdata: 'Microdata', rdfa: 'RDFa' };

/**
 * Bounds on reading the page's structured data in main (`@app/seo-core`, `analyseSchema`). The text
 * is untrusted: whatever passes these bounds is cut, never followed further.
 * - `maxDepth`: objects and arrays nested in one JSON-LD block deeper than this are not read
 *   (`schema-over-limit`); a markup item tree is bounded by `SNAPSHOT_LIMITS.maxMarkupDepth`.
 * - `maxNodes`: JSON values (objects, arrays and primitives) read across all the page's blocks;
 *   the rest are not read (`schema-over-limit`).
 * - `maxEntities`: entities (typed or untyped objects, markup items) in the page's tree in all.
 * - `maxValueChars`: characters of one text value kept in the tree (its full length is kept too).
 * - `maxPrettyChars`: the longest pretty-printed JSON the raw view and "Copy JSON" produce; a
 *   longer one is cut there.
 * - `maxPrettyIndent`: nesting levels the pretty printer indents; deeper levels share its indent.
 */
export const SCHEMA_PARSE_LIMITS = {
  maxDepth: 32,
  maxNodes: 5_000,
  maxEntities: 1_000,
  maxValueChars: 1_024,
  maxPrettyChars: 1_000_000,
  maxPrettyIndent: 24,
} as const;

/**
 * Object keys dropped while a JSON-LD block is read, wherever they appear: they name JavaScript
 * object internals, never schema.org terms, and keeping them is how prototype pollution starts.
 * Nothing frost builds from page JSON is a plain object indexed by a page key: properties are lists
 * of `{ name, values }`, and `@id`s go in a `Map`.
 */
export const SCHEMA_DROPPED_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * The schema.org vocabulary: `@context` values, microdata `itemtype`s and RDFa `vocab`s on these
 * hosts (http or https; any path below the root, such as `/` or `/docs/jsonldcontext.json`) are
 * schema.org. Type and property IRIs under them are shortened to the term (`https://schema.org/Product`
 * → `Product`), as is the `schema:` prefix (`schema:Product`).
 */
export const SCHEMA_ORG_HOSTS = ['schema.org', 'www.schema.org'] as const;

/**
 * Common schema.org types frost recognises. A type outside this list and its parent map
 * (`SCHEMA_TYPE_PARENTS`) is reported as `schema-type-unknown` (info only: schema.org has far more
 * types than this, and an unusual type may be right).
 */
export const SCHEMA_COMMON_TYPES = [
  'Thing',
  'CreativeWork',
  'WebSite',
  'WebPage',
  'AboutPage',
  'CheckoutPage',
  'CollectionPage',
  'ContactPage',
  'FAQPage',
  'ItemPage',
  'MedicalWebPage',
  'ProfilePage',
  'QAPage',
  'RealEstateListing',
  'SearchResultsPage',
  'WebPageElement',
  'SiteNavigationElement',
  'WPHeader',
  'WPFooter',
  'WPSideBar',
  'Article',
  'SocialMediaPosting',
  'DiscussionForumPosting',
  'Blog',
  'Book',
  'Chapter',
  'Course',
  'Dataset',
  'DigitalDocument',
  'Guide',
  'HowTo',
  'HowToStep',
  'HowToSection',
  'HowToDirection',
  'HowToTip',
  'HowToSupply',
  'HowToTool',
  'Recipe',
  'Menu',
  'MenuItem',
  'MenuSection',
  'Movie',
  'MusicAlbum',
  'MusicPlaylist',
  'MusicRecording',
  'Painting',
  'Photograph',
  'Podcast',
  'PodcastEpisode',
  'PodcastSeries',
  'Quotation',
  'Review',
  'CriticReview',
  'EmployerReview',
  'UserReview',
  'SoftwareApplication',
  'MobileApplication',
  'WebApplication',
  'VideoGame',
  'SoftwareSourceCode',
  'TVSeries',
  'TVEpisode',
  'TVSeason',
  'CreativeWorkSeries',
  'Episode',
  'Clip',
  'Collection',
  'Question',
  'Answer',
  'Comment',
  'Claim',
  'ClaimReview',
  'EducationalOccupationalProgram',
  'LearningResource',
  'Quiz',
  'MathSolver',
  'Certification',
  'MediaObject',
  'ImageObject',
  'VideoObject',
  'AudioObject',
  'DataDownload',
  'MediaGallery',
  'ImageGallery',
  'VideoGallery',
  'Organization',
  'Person',
  'Place',
  'LocalBusiness',
  'Product',
  'ProductGroup',
  'Brand',
  'Offer',
  'AggregateOffer',
  'OfferCatalog',
  'OfferShippingDetails',
  'ShippingDeliveryTime',
  'MerchantReturnPolicy',
  'Demand',
  'PriceSpecification',
  'UnitPriceSpecification',
  'CompoundPriceSpecification',
  'DeliveryChargeSpecification',
  'Rating',
  'AggregateRating',
  'Event',
  'BreadcrumbList',
  'ItemList',
  'ListItem',
  'HowToItem',
  'JobPosting',
  'Occupation',
  'MonetaryAmount',
  'MonetaryAmountDistribution',
  'QuantitativeValue',
  'PropertyValue',
  'PostalAddress',
  'ContactPoint',
  'GeoCoordinates',
  'GeoShape',
  'Country',
  'State',
  'City',
  'AdministrativeArea',
  'TouristAttraction',
  'TouristDestination',
  'LandmarksOrHistoricalBuildings',
  'Park',
  'Museum',
  'Residence',
  'Accommodation',
  'Apartment',
  'House',
  'Room',
  'Landform',
  'OpeningHoursSpecification',
  'DayOfWeek',
  'Duration',
  'Language',
  'EntryPoint',
  'Action',
  'SearchAction',
  'ReadAction',
  'WatchAction',
  'BuyAction',
  'OrderAction',
  'ReserveAction',
  'CommunicateAction',
  'InteractionCounter',
  'NutritionInformation',
  'Audience',
  'PeopleAudience',
  'DefinedTerm',
  'DefinedTermSet',
  'DefinedRegion',
  'SpeakableSpecification',
  'Role',
  'OrganizationRole',
  'EmployeeRole',
  'PerformanceRole',
  'Service',
  'FinancialProduct',
  'BroadcastService',
  'Trip',
  'Flight',
  'Reservation',
  'Ticket',
  'Seat',
  'MedicalCondition',
  'Drug',
  'Specialty',
  'MedicalSpecialty',
  'EventStatusType',
  'EventAttendanceModeEnumeration',
  'ItemAvailability',
  'OfferItemCondition',
  'Enumeration',
  'StructuredValue',
  'Intangible',
  'Grant',
  'SizeSpecification',
  'Distance',
  'Energy',
  'Mass',
  'VirtualLocation',
] as const;

/**
 * Subtypes frost recognises, each with its schema.org parent. A node is checked against the
 * property sets (`SCHEMA_TYPE_RULES`) of the first type with a set found walking up from each of its
 * types (`Restaurant` → `FoodEstablishment` → `LocalBusiness`). Only the branches whose rule sets
 * fit the subtype are mapped to them: `SocialMediaPosting` and `DiscussionForumPosting` are known
 * types, but not held to `Article`'s set, and `ProductGroup` not to `Product`'s.
 */
export const SCHEMA_TYPE_PARENTS: Readonly<Record<string, string>> = {
  // Articles
  NewsArticle: 'Article',
  AnalysisNewsArticle: 'NewsArticle',
  AskPublicNewsArticle: 'NewsArticle',
  BackgroundNewsArticle: 'NewsArticle',
  OpinionNewsArticle: 'NewsArticle',
  ReportageNewsArticle: 'NewsArticle',
  ReviewNewsArticle: 'NewsArticle',
  BlogPosting: 'Article',
  LiveBlogPosting: 'BlogPosting',
  TechArticle: 'Article',
  APIReference: 'TechArticle',
  ScholarlyArticle: 'Article',
  MedicalScholarlyArticle: 'ScholarlyArticle',
  Report: 'Article',
  AdvertiserContentArticle: 'Article',
  SatiricalArticle: 'Article',
  // Organizations
  Corporation: 'Organization',
  NGO: 'Organization',
  GovernmentOrganization: 'Organization',
  EducationalOrganization: 'Organization',
  CollegeOrUniversity: 'EducationalOrganization',
  School: 'EducationalOrganization',
  HighSchool: 'EducationalOrganization',
  ElementarySchool: 'EducationalOrganization',
  Preschool: 'EducationalOrganization',
  NewsMediaOrganization: 'Organization',
  SportsOrganization: 'Organization',
  SportsTeam: 'SportsOrganization',
  PerformingGroup: 'Organization',
  MusicGroup: 'PerformingGroup',
  TheaterGroup: 'PerformingGroup',
  DanceGroup: 'PerformingGroup',
  OnlineBusiness: 'Organization',
  OnlineStore: 'OnlineBusiness',
  Airline: 'Organization',
  Consortium: 'Organization',
  Cooperative: 'Organization',
  ResearchOrganization: 'Organization',
  LibrarySystem: 'Organization',
  PoliticalParty: 'Organization',
  WorkersUnion: 'Organization',
  FundingScheme: 'Organization',
  MedicalOrganization: 'Organization',
  Hospital: 'MedicalOrganization',
  // Local businesses
  FoodEstablishment: 'LocalBusiness',
  Restaurant: 'FoodEstablishment',
  CafeOrCoffeeShop: 'FoodEstablishment',
  Bakery: 'FoodEstablishment',
  BarOrPub: 'FoodEstablishment',
  Brewery: 'FoodEstablishment',
  Distillery: 'FoodEstablishment',
  FastFoodRestaurant: 'FoodEstablishment',
  IceCreamShop: 'FoodEstablishment',
  Winery: 'FoodEstablishment',
  Store: 'LocalBusiness',
  AutoPartsStore: 'Store',
  BikeStore: 'Store',
  BookStore: 'Store',
  ClothingStore: 'Store',
  ComputerStore: 'Store',
  ConvenienceStore: 'Store',
  DepartmentStore: 'Store',
  ElectronicsStore: 'Store',
  Florist: 'Store',
  FurnitureStore: 'Store',
  GardenStore: 'Store',
  GroceryStore: 'Store',
  HardwareStore: 'Store',
  HobbyShop: 'Store',
  HomeGoodsStore: 'Store',
  JewelryStore: 'Store',
  LiquorStore: 'Store',
  MensClothingStore: 'Store',
  MobilePhoneStore: 'Store',
  MovieRentalStore: 'Store',
  MusicStore: 'Store',
  OfficeEquipmentStore: 'Store',
  OutletStore: 'Store',
  PawnShop: 'Store',
  PetStore: 'Store',
  ShoeStore: 'Store',
  SportingGoodsStore: 'Store',
  TireShop: 'Store',
  ToyStore: 'Store',
  WholesaleStore: 'Store',
  AutomotiveBusiness: 'LocalBusiness',
  AutoDealer: 'AutomotiveBusiness',
  AutoRepair: 'AutomotiveBusiness',
  GasStation: 'AutomotiveBusiness',
  HealthAndBeautyBusiness: 'LocalBusiness',
  BeautySalon: 'HealthAndBeautyBusiness',
  DaySpa: 'HealthAndBeautyBusiness',
  HairSalon: 'HealthAndBeautyBusiness',
  NailSalon: 'HealthAndBeautyBusiness',
  HealthClub: 'HealthAndBeautyBusiness',
  LodgingBusiness: 'LocalBusiness',
  Hotel: 'LodgingBusiness',
  Motel: 'LodgingBusiness',
  Hostel: 'LodgingBusiness',
  BedAndBreakfast: 'LodgingBusiness',
  Campground: 'LodgingBusiness',
  Resort: 'LodgingBusiness',
  MedicalBusiness: 'LocalBusiness',
  Dentist: 'MedicalBusiness',
  Optician: 'MedicalBusiness',
  Pharmacy: 'MedicalBusiness',
  Physician: 'MedicalBusiness',
  MedicalClinic: 'MedicalBusiness',
  ProfessionalService: 'LocalBusiness',
  LegalService: 'LocalBusiness',
  Attorney: 'LegalService',
  Notary: 'LegalService',
  FinancialService: 'LocalBusiness',
  AccountingService: 'FinancialService',
  BankOrCreditUnion: 'FinancialService',
  InsuranceAgency: 'FinancialService',
  HomeAndConstructionBusiness: 'LocalBusiness',
  Electrician: 'HomeAndConstructionBusiness',
  GeneralContractor: 'HomeAndConstructionBusiness',
  HVACBusiness: 'HomeAndConstructionBusiness',
  HousePainter: 'HomeAndConstructionBusiness',
  Locksmith: 'HomeAndConstructionBusiness',
  MovingCompany: 'HomeAndConstructionBusiness',
  Plumber: 'HomeAndConstructionBusiness',
  RoofingContractor: 'HomeAndConstructionBusiness',
  EntertainmentBusiness: 'LocalBusiness',
  MovieTheater: 'EntertainmentBusiness',
  NightClub: 'EntertainmentBusiness',
  AmusementPark: 'EntertainmentBusiness',
  SportsActivityLocation: 'LocalBusiness',
  ExerciseGym: 'SportsActivityLocation',
  GolfCourse: 'SportsActivityLocation',
  RealEstateAgent: 'LocalBusiness',
  TravelAgency: 'LocalBusiness',
  ChildCare: 'LocalBusiness',
  DryCleaningOrLaundry: 'LocalBusiness',
  EmploymentAgency: 'LocalBusiness',
  Library: 'LocalBusiness',
  SelfStorage: 'LocalBusiness',
  ShoppingCenter: 'LocalBusiness',
  TouristInformationCenter: 'LocalBusiness',
  AnimalShelter: 'LocalBusiness',
  RadioStation: 'LocalBusiness',
  RecyclingCenter: 'LocalBusiness',
  // Events
  BusinessEvent: 'Event',
  ChildrensEvent: 'Event',
  ComedyEvent: 'Event',
  CourseInstance: 'Event',
  DanceEvent: 'Event',
  EducationEvent: 'Event',
  ExhibitionEvent: 'Event',
  Festival: 'Event',
  FoodEvent: 'Event',
  Hackathon: 'Event',
  LiteraryEvent: 'Event',
  MusicEvent: 'Event',
  PublicationEvent: 'Event',
  SaleEvent: 'Event',
  ScreeningEvent: 'Event',
  SocialEvent: 'Event',
  SportsEvent: 'Event',
  TheaterEvent: 'Event',
  VisualArtsEvent: 'Event',
  // Products
  IndividualProduct: 'Product',
  ProductModel: 'Product',
  SomeProducts: 'Product',
  Vehicle: 'Product',
  Car: 'Vehicle',
  Motorcycle: 'Vehicle',
  // People
  Patient: 'Person',
};

/**
 * One property requirement: a property name (present with a value), or a list of alternatives
 * (any one of them will do). An alternative may look one level into a nested node:
 * `item.name` is the `name` of the node in `item`.
 */
export type SchemaRequirement = string | readonly string[];

export interface SchemaTypeRule {
  /** Missing any of these: `schema-required-missing` (checked on every node of the type). */
  readonly required: readonly SchemaRequirement[];
  /** Missing any of these: `schema-recommended-missing` (checked on top-level nodes only, so a nested author or publisher is not held to a full profile). */
  readonly recommended: readonly SchemaRequirement[];
}

/**
 * frost's property sets for the types it checks. A node of a subtype uses its nearest checked
 * ancestor's set (`SCHEMA_TYPE_PARENTS`). The reasoning, in short:
 * - Organization / Person: a name is what identifies them; a URL, a logo or image and `sameAs`
 *   profiles let search engines tie the entity to the rest of the web.
 * - WebSite: its name and home URL are the site's identity in results.
 * - BreadcrumbList / ListItem: a trail is a list of positioned, named steps.
 * - Article and its kinds: a headline is the article; the image, the author and the dates make it
 *   eligible for richer article results.
 * - Product: a name, plus something that makes it a product result: an offer to buy it, a review or
 *   a rating.
 * - FAQPage / Question / Answer: a page of questions, each with its answer's text.
 * - LocalBusiness: a name and an address are what put a business on a map.
 * - Event: what, when and where.
 * - Recipe: its name and a picture of the dish.
 * - VideoObject: a name, a thumbnail and when it was uploaded, so the video can be listed.
 */
export const SCHEMA_TYPE_RULES: Readonly<Record<string, SchemaTypeRule>> = {
  Organization: { required: ['name'], recommended: ['url', 'logo', 'sameAs'] },
  WebSite: { required: ['name', 'url'], recommended: ['publisher'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: [] },
  ListItem: { required: ['position', ['name', 'item.name']], recommended: [] },
  Article: { required: ['headline'], recommended: ['image', 'author', 'datePublished', 'dateModified'] },
  Product: {
    required: ['name', ['offers', 'review', 'aggregateRating']],
    recommended: ['image', 'description', 'brand', ['sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn']],
  },
  FAQPage: { required: ['mainEntity'], recommended: [] },
  Question: { required: ['name', 'acceptedAnswer'], recommended: [] },
  Answer: { required: ['text'], recommended: [] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'url', ['openingHoursSpecification', 'openingHours'], 'geo', 'image'] },
  Event: { required: ['name', 'startDate', 'location'], recommended: ['endDate', 'description', 'image', 'eventStatus', 'offers', 'organizer'] },
  Recipe: { required: ['name', 'image'], recommended: ['author', 'description', 'recipeIngredient', 'recipeInstructions', 'recipeYield', ['totalTime', 'cookTime', 'prepTime']] },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'duration', ['contentUrl', 'embedUrl']] },
  Person: { required: ['name'], recommended: ['url', 'sameAs'] },
};

/**
 * Properties whose text values must be absolute `http(s)` URLs (`schema-url-not-absolute`). A value
 * that is a node (an `ImageObject` in `image`, a `WebPage` in `mainEntityOfPage`) is checked through
 * its own properties instead.
 */
export const SCHEMA_URL_PROPERTIES = ['url', 'image', 'logo', 'sameAs', 'thumbnailUrl', 'contentUrl', 'embedUrl', 'item', 'mainEntityOfPage', 'hasMap', 'downloadUrl', 'installUrl', 'discussionUrl'] as const;

/** Properties whose text values must be ISO 8601 dates or date-times (`schema-date-invalid`). */
export const SCHEMA_DATE_PROPERTIES = [
  'datePublished',
  'dateModified',
  'dateCreated',
  'uploadDate',
  'startDate',
  'endDate',
  'previousStartDate',
  'validFrom',
  'validThrough',
  'priceValidUntil',
  'availabilityStarts',
  'availabilityEnds',
  'birthDate',
  'deathDate',
  'foundingDate',
  'dissolutionDate',
  'expires',
] as const;

/** Properties whose text values must be ISO 8601 durations, such as `PT1H30M` (`schema-date-invalid`). */
export const SCHEMA_DURATION_PROPERTIES = ['duration', 'prepTime', 'cookTime', 'totalTime', 'performTime', 'timeRequired'] as const;

/**
 * Types a site should describe once (`schema-entity-conflict`): two top-level nodes of the same one
 * of these types (other than the same `@id`) whose `SCHEMA_IDENTITY_PROPERTIES` both have a value
 * and differ (case and a trailing `/` aside) conflict.
 */
export const SCHEMA_SINGLETON_TYPES = ['Organization', 'WebSite'] as const;
export const SCHEMA_IDENTITY_PROPERTIES = ['name', 'url'] as const;

/** The Schema panel's raw view of a JSON-LD block, and "Copy JSON" (`seo.copySchemaJson`). */
export const SCHEMA_VIEWS = ['tree', 'raw'] as const;
export type SchemaView = (typeof SCHEMA_VIEWS)[number];
