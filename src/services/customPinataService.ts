import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';

export interface PinataConfig {
  jwtToken: string;
  gatewayUrl?: string;
}

export interface StorageResult {
  cid: string;
  url: string;
  size: number;
}

export class CustomPinataService {
  private jwtToken: string;
  private gatewayUrl: string;

  constructor(config: PinataConfig) {
    this.jwtToken = config.jwtToken;
    this.gatewayUrl = config.gatewayUrl || 'https://gateway.pinata.cloud';
  }

  /**
   * Upload data to Pinata IPFS
   */
  async put(data: any, mime: string = "application/json"): Promise<string> {
    try {
      const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(JSON.stringify(data));
      
      const formData = new FormData();
      formData.append("file", buffer, {
        contentType: mime,
        filename: `file_${Date.now()}`
      });

      const response = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${this.jwtToken}`
        }
      });

      const cid = response.data.IpfsHash;
      console.log(chalk.green(`✅ Data uploaded to Pinata:`));
      console.log(chalk.gray(`   CID: ${cid}`));
      console.log(chalk.gray(`   Size: ${response.data.PinSize} bytes`));

      return cid;
    } catch (error) {
      console.error(chalk.red(`❌ Pinata upload failed: ${error}`));
      throw error;
    }
  }

  /**
   * Get data from Pinata IPFS
   */
  async get(cid: string): Promise<any> {
    try {
      const url = `${this.gatewayUrl}/ipfs/${cid}`;
      const response = await axios.get(url);
      
      console.log(chalk.blue(`📥 Retrieved data from Pinata: ${cid}`));
      return response.data;
    } catch (error) {
      console.error(chalk.red(`❌ Pinata retrieval failed: ${error}`));
      throw error;
    }
  }

  /**
   * Pin a CID to Pinata
   */
  async pin(cid: string): Promise<void> {
    try {
      await axios.post("https://api.pinata.cloud/pinning/pinByHash", {
        hashToPin: cid
      }, {
        headers: {
          Authorization: `Bearer ${this.jwtToken}`
        }
      });
      
      console.log(chalk.green(`📌 Pinned CID to Pinata: ${cid}`));
    } catch (error) {
      console.error(chalk.red(`❌ Pinata pin failed: ${error}`));
      throw error;
    }
  }

  /**
   * Unpin a CID from Pinata
   */
  async unpin(cid: string): Promise<void> {
    try {
      await axios.delete(`https://api.pinata.cloud/pinning/unpin/${cid}`, {
        headers: {
          Authorization: `Bearer ${this.jwtToken}`
        }
      });
      
      console.log(chalk.yellow(`📌 Unpinned CID from Pinata: ${cid}`));
    } catch (error) {
      console.error(chalk.red(`❌ Pinata unpin failed: ${error}`));
      throw error;
    }
  }

  /**
   * Get gateway URL for a CID
   */
  getGatewayUrl(cid: string): string {
    return `${this.gatewayUrl}/ipfs/${cid}`;
  }

  /**
   * Test connection to Pinata
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get("https://api.pinata.cloud/data/testAuthentication", {
        headers: {
          Authorization: `Bearer ${this.jwtToken}`
        }
      });
      
      console.log(chalk.green(`✅ Pinata connection successful`));
      console.log(chalk.gray(`   User: ${response.data.username}`));
      console.log(chalk.gray(`   Email: ${response.data.email}`));
      return true;
    } catch (error) {
      console.error(chalk.red(`❌ Pinata connection failed: ${error}`));
      return false;
    }
  }
}

/**
 * Create a custom Pinata service instance from environment variables
 */
export function createCustomPinataService(): CustomPinataService {
  const jwtToken = process.env.PINATA_JWT;
  
  if (!jwtToken) {
    throw new Error('PINATA_JWT environment variable is required');
  }

  return new CustomPinataService({
    jwtToken,
    gatewayUrl: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud',
  });
}
