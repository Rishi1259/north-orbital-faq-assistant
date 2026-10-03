export const up = (pgm) => {
  pgm.createExtension('vector', {
    ifNotExists: true,
  });

  pgm.createExtension('pgcrypto', {
    ifNotExists: true,
  });

  pgm.createTable('organizations', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default:
        pgm.func('gen_random_uuid()'),
    },

    name: {
      type: 'text',
      notNull: true,
    },

    slug: {
      type: 'text',
      notNull: true,
      unique: true,
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default:
        pgm.func(
          'current_timestamp',
        ),
    },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default:
        pgm.func(
          'current_timestamp',
        ),
    },
  });

  pgm.createTable('chatbots', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default:
        pgm.func('gen_random_uuid()'),
    },

    organization_id: {
      type: 'uuid',
      notNull: true,
      references:
        'organizations(id)',
      onDelete: 'CASCADE',
    },

    name: {
      type: 'text',
      notNull: true,
    },

    status: {
      type: 'text',
      notNull: true,
      default: 'draft',
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default:
        pgm.func(
          'current_timestamp',
        ),
    },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default:
        pgm.func(
          'current_timestamp',
        ),
    },
  });

  pgm.createIndex(
    'chatbots',
    'organization_id',
  );
};

export const down = (pgm) => {
  pgm.dropTable(
    'chatbots',
  );

  pgm.dropTable(
    'organizations',
  );
};