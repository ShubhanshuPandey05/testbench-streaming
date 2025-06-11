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

getAllProducts();