import { fetchCompanyNews } from './source.js'

export async function news(company, options = {}) {
  return fetchCompanyNews(company, options)
}
