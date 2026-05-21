export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  discount_price?: number;
  category_id: string;
  room_id?: string;
  material?: string;
  dimensions?: string;
  stock: number;
  status: 'active' | 'inactive';
  images: string[];
  tags: string[];
  rating: number;
  review_count: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  icon_url?: string;
  image_url?: string;
  product_count: number;
}

export interface Room {
  id: string;
  name: string;
  slug: string;
  image_url: string;
  discount_text?: string;
}

export interface Order {
  id: string;
  user_id: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  total_amount: number;
  shipping_address: ShippingAddress;
  payment_status: 'pending' | 'paid' | 'failed' | 'refunded';
  payment_intent_id?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  order_items?: OrderItem[];
  profiles?: Profile;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  price_at_time: number;
  products?: Product;
}

export type Role = 'customer' | 'admin' | 'super_admin' | 'sub_admin';

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  phone?: string;
  address?: string;
  avatar_url?: string;
  created_at: string;
}

export interface ShippingAddress {
  full_name: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone?: string;
}

export interface Review {
  id: string;
  product_id: string;
  user_id: string;
  rating: number;
  comment: string;
  created_at: string;
  profiles?: Profile;
}

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
