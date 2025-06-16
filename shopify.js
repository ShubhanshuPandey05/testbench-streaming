require('dotenv').config();
const fetch = require('node-fetch');

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL; // e.g., "your-store.myshopify.com"
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const graphqlEndpoint = `https://${SHOPIFY_STORE_URL}/admin/api/2023-01/graphql.json`;

const query = `
{
  products(first: 5) {
    edges {
      node {
        id
        title
        handle
        description
        variants(first: 1) {
          edges {
            node {
              id
              title
            }
          }
        }
      }
    }
  }
}
`;

// Helper function to parse products from the API response
function parseProductsResponse(data) {
  if (!data.data || !data.data.products) return [];
  return data.data.products.edges.map(edge => ({
    id: edge.node.id,
    title: edge.node.title,
    handle: edge.node.handle,
    description: edge.node.description,
    variants: edge.node.variants.edges.map(variantEdge => ({
      id: variantEdge.node.id,
      title: variantEdge.node.title
    }))
  }));
}

// fetch(graphqlEndpoint, {
//     method: 'POST',
//     headers: {
//         'Content-Type': 'application/json',
//         'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
//     },
//     body: JSON.stringify({ query }),
// })
//     .then(response => response.json())
//     .then(data => {
//         // Parse the products
//         const products = parseProductsResponse(data);

//         // Print a clean list of products and their variants
//         products.forEach(product => {
//             console.log(`Product: ${product.title} (ID: ${product.id})`);
//             console.log(`  Handle: ${product.handle}`);
//             console.log(`  Description: ${product.description}`);
//             product.variants.forEach(variant => {
//                 console.log(`    Variant: ${variant.title} (ID: ${variant.id})`);
//             });
//             console.log('-----------------------------');
//         });

//         // Optionally, print the raw data for debugging
//         // console.log(JSON.stringify(data, null, 2));
//     })
//     .catch(error => console.error('Error fetching products:', error));


const createCustomerMutation = `
mutation customerCreate($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer {
      id
      firstName
      lastName
      email
      phone
      ordersCount
      createdAt
      updatedAt
    }
    userErrors {
      field
      message
    }
  }
}
`;


async function getAllProducts(cursor = null) {
  const query = `
    {
      products(first: 50${cursor ? `, after: "${cursor}"` : ''}) {
        edges {
          cursor
          node {
            id
            title
            handle
            description
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const response = await fetch(graphqlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  if (!data.data || !data.data.products) return { products: [], hasNextPage: false, lastCursor: null };

  const products = data.data.products.edges.map(edge => ({
    id: edge.node.id,
    title: edge.node.title,
    handle: edge.node.handle,
    description: edge.node.description,
    variants: edge.node.variants.edges.map(variantEdge => ({
      id: variantEdge.node.id,
      title: variantEdge.node.title
    }))
  }));

  const hasNextPage = data.data.products.pageInfo.hasNextPage;
  const lastCursor = data.data.products.edges.length > 0 ? data.data.products.edges[data.data.products.edges.length - 1].cursor : null;


  console.log(products)

  return { products };
}

// getAllProducts();


async function getUserDetailsByPhoneNo(phone) {
  console.log('Searching for phone:', phone);

  const query = `
  {
    customers(first: 1, query: "phone:${phone}") {
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          numberOfOrders
        }
      }
    }
  }
  `;

  try {
    const response = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Check for GraphQL errors
    if (data.errors) {
      console.error('GraphQL errors:', data.errors);
      return null;
    }

    // Check if customer found
    if (!data.data || !data.data.customers.edges.length) {
      console.log('No customer found with phone:', phone);
      return null;
    }

    const user = data.data.customers.edges[0].node;

    // Fixed: log the actual available properties
    console.log('Found user:', user.firstName, user.lastName);

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      ordersCount: user.ordersCount
    };

  } catch (error) {
    console.error('Error fetching user details:', error);
    return null;
  }
}

// Alternative version with phone number normalization
async function getUserDetailsByPhoneNoWithNormalization(phone) {
  // Normalize phone number - remove spaces, dashes, parentheses
  const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');

  console.log('Searching for phone:', phone, 'normalized:', normalizedPhone);

  // Try multiple phone formats if the first search fails
  const phoneVariants = [
    phone,                    // Original format
    normalizedPhone,          // Digits only
    `+1${normalizedPhone}`,   // With country code
    normalizedPhone.replace(/^1/, ''), // Remove leading 1
  ];

  for (const phoneVariant of phoneVariants) {
    const query = `
{
  customers(first: 1, query: "phone:${phoneVariant}") {
    edges {
      node {
        id
        firstName
        lastName
        email
        phone
        ordersCount
      }
    }
  }
}
`;

    try {
      const response = await fetch(graphqlEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) continue;

      const data = await response.json();

      if (data.errors) {
        console.error('GraphQL errors:', data.errors);
        continue;
      }

      if (data.data && data.data.customers.edges.length) {
        const user = data.data.customers.edges[0].node;
        console.log('Found user with phone variant:', phoneVariant, '- User:', user.firstName, user.lastName);

        return {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          ordersCount: user.ordersCount
        };
      }
    } catch (error) {
      console.error(`Error with phone variant ${phoneVariant}:`, error);
      continue;
    }
  }

  console.log('No customer found with any phone variant for:', phone);
  return null;
}

getUserDetailsByPhoneNo("+919313562780");
// getUserDetailsByPhoneNoWithNormalization("+91 93135 62780");

// Function to create a customer
// async function createCustomer(customerData) {
//   const variables = {
//     input: {
//       firstName: customerData.firstName,
//       lastName: customerData.lastName,
//       email: customerData.email,
//       phone: customerData.phone,
//       // Optional fields:
//       // acceptsMarketing: customerData.acceptsMarketing || false,
//       // addresses: customerData.addresses || [],
//       // tags: customerData.tags || [],
//       // note: customerData.note || "",
//       // password: customerData.password, // Only if you want them to have an account
//     }
//   };

//   try {
//     const response = await fetch(graphqlEndpoint, {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
//       },
//       body: JSON.stringify({
//         query: createCustomerMutation,
//         variables
//       }),
//     });

//     if (!response.ok) {
//       throw new Error(`HTTP error! status: ${response.status}`);
//     }

//     const data = await response.json();

//     // Check for GraphQL errors
//     if (data.errors) {
//       console.error('GraphQL errors:', data.errors);
//       return { success: false, errors: data.errors };
//     }

//     // Check for user errors (validation errors)
//     if (data.data.customerCreate.userErrors.length > 0) {
//       console.error('User errors:', data.data.customerCreate.userErrors);
//       return { success: false, errors: data.data.customerCreate.userErrors };
//     }

//     console.log('Customer created successfully:', data.data.customerCreate.customer);
//     return {
//       success: true,
//       customer: data.data.customerCreate.customer
//     };

//   } catch (error) {
//     console.error('Error creating customer:', error);
//     return { success: false, error: error.message };
//   }
// }

// createCustomer({
//   firstName: "Jane",
//   lastName: "Smith",
//   email: "jane.smith@example.com",
//   phone: "+1-555-123-4567"
// });